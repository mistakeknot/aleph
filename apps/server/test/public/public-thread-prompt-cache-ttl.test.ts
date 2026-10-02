import { getThread } from "@bb/db";
import { encodeClientTurnRequestIdNumber } from "@bb/domain";
import { threadResponseSchema } from "@bb/server-contract";
import { describe, expect, it } from "vitest";
import {
  buildExecutionOptions,
  buildThreadStartCommand,
  prepareTurnSubmitCommandPayload,
} from "../../src/services/threads/thread-commands.js";
import { waitForQueuedCommand } from "../helpers/commands.js";
import { readJson } from "../helpers/json.js";
import { textInput } from "../helpers/prompt-input.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
  seedThreadRuntimeState,
  seedTurnStarted,
} from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

function seedCreateTarget(harness: TestAppHarness) {
  const { host } = seedHostSession(harness.deps);
  const { project } = seedProjectWithSource(harness.deps, {
    hostId: host.id,
    path: "/tmp/prompt-cache-ttl",
  });
  const environment = seedEnvironment(harness.deps, {
    hostId: host.id,
    projectId: project.id,
    path: "/tmp/prompt-cache-ttl",
  });
  return { environment, host, project };
}

async function postCreate(
  harness: TestAppHarness,
  body: Record<string, unknown>,
) {
  return harness.app.request("/api/v1/threads", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function createBody(args: {
  hostId: string;
  projectId: string;
  providerOptions?: unknown;
}) {
  return {
    origin: "app",
    projectId: args.projectId,
    providerId: "claude-code",
    model: "claude-sonnet-4-6",
    input: [{ type: "text", text: "hello" }],
    environment: {
      type: "host",
      hostId: args.hostId,
      workspace: { type: "unmanaged", path: null },
    },
    ...(args.providerOptions === undefined
      ? {}
      : { providerOptions: args.providerOptions }),
  };
}

async function postFork(
  harness: TestAppHarness,
  body: Record<string, unknown>,
) {
  return harness.app.request("/api/v1/threads/fork", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("per-thread prompt cache TTL", () => {
  it("round-trips 1h from spawn to thread read to the first claude-code session", async () => {
    await withTestHarness(async (harness) => {
      const { host, project } = seedCreateTarget(harness);

      const response = await postCreate(
        harness,
        createBody({
          hostId: host.id,
          projectId: project.id,
          providerOptions: { promptCacheTtl: "1h" },
        }),
      );
      expect(response.status).toBe(201);
      const created = threadResponseSchema.parse(await readJson(response));
      expect(created.promptCacheTtl).toBe("1h");

      const read = await harness.app.request(`/api/v1/threads/${created.id}`);
      expect(read.status).toBe(200);
      expect(
        threadResponseSchema.parse(await readJson(read)).promptCacheTtl,
      ).toBe("1h");

      const start = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.start" && command.threadId === created.id,
      );
      expect(start.command).toMatchObject({
        options: { providerOptions: { promptCacheTtl: "1h" } },
      });
    });
  });

  it("rejects values other than 5m and 1h and unknown provider options", async () => {
    await withTestHarness(async (harness) => {
      const { host, project } = seedCreateTarget(harness);

      for (const providerOptions of [
        { promptCacheTtl: "2h" },
        { promptCacheTtl: 3600 },
        { promptCacheTtl: "1h", memoryEnabled: false },
      ]) {
        const response = await postCreate(
          harness,
          createBody({
            hostId: host.id,
            projectId: project.id,
            providerOptions,
          }),
        );
        expect(response.status).toBe(400);
      }
    });
  });

  it("leaves a thread created without it unchanged", async () => {
    await withTestHarness(async (harness) => {
      const { host, project } = seedCreateTarget(harness);

      const response = await postCreate(
        harness,
        createBody({ hostId: host.id, projectId: project.id }),
      );
      expect(response.status).toBe(201);
      const created = threadResponseSchema.parse(await readJson(response));
      expect(created.promptCacheTtl).toBeNull();

      const start = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.start" && command.threadId === created.id,
      );
      expect(start.command).toMatchObject({
        options: {
          providerOptions: {
            chromeEnabled: false,
            memoryEnabled: true,
            providerSubagentsEnabled: true,
            workflowsEnabled: true,
          },
        },
      });
      if (start.command.type !== "thread.start") {
        throw new Error("expected thread.start");
      }
      expect(start.command.options.providerOptions).not.toHaveProperty(
        "promptCacheTtl",
      );
    });
  });

  it("keeps the value across resume", async () => {
    await withTestHarness(async (harness) => {
      const { environment, project } = seedCreateTarget(harness);
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        providerId: "claude-code",
        promptCacheTtl: "1h",
      });
      seedThreadRuntimeState(harness.deps, {
        environmentId: environment.id,
        permissionMode: "full",
        providerThreadId: "provider-ttl-resume",
        threadId: thread.id,
      });
      const execution = await buildExecutionOptions(
        harness.deps,
        { model: "claude-sonnet-4-6" },
        { threadId: thread.id },
      );

      const resumed = await prepareTurnSubmitCommandPayload(harness.deps, {
        environment,
        execution,
        permissionEscalation: "ask",
        input: textInput("continue"),
        target: { mode: "start" },
        thread,
      });
      expect(resumed.options.providerOptions).toMatchObject({
        promptCacheTtl: "1h",
      });

      const restarted = await buildThreadStartCommand(harness.deps, {
        environment,
        execution,
        fork: null,
        permissionEscalation: "ask",
        input: textInput("again"),
        projectId: project.id,
        providerId: "claude-code",
        requestId: encodeClientTurnRequestIdNumber({ value: 1 }),
        syncGeneratedTitle: false,
        thread,
      });
      expect(restarted.options.providerOptions).toMatchObject({
        promptCacheTtl: "1h",
      });
    });
  });

  describe("fork", () => {
    function seedSource(
      harness: TestAppHarness,
      promptCacheTtl: "5m" | "1h" | null,
    ) {
      const { environment, project } = seedCreateTarget(harness);
      const sourceThread = seedThread(harness.deps, {
        environmentId: environment.id,
        projectId: project.id,
        providerId: "claude-code",
        promptCacheTtl,
      });
      seedThreadRuntimeState(harness.deps, {
        environmentId: environment.id,
        permissionMode: "full",
        providerThreadId: "provider-ttl-source",
        threadId: sourceThread.id,
      });
      seedTurnStarted(harness.deps, {
        environmentId: environment.id,
        providerThreadId: "provider-ttl-source",
        sequence: 3,
        threadId: sourceThread.id,
        turnId: "turn-ttl-source",
      });
      return sourceThread;
    }

    it("inherits the source value unless the request overrides it", async () => {
      await withTestHarness(async (harness) => {
        const source = seedSource(harness, "1h");

        const inherited = await postFork(harness, {
          sourceThreadId: source.id,
        });
        expect(inherited.status).toBe(201);
        const inheritedFork = threadResponseSchema.parse(
          await readJson(inherited),
        );
        expect(inheritedFork.promptCacheTtl).toBe("1h");
        expect(getThread(harness.db, inheritedFork.id)?.promptCacheTtl).toBe(
          "1h",
        );

        const overridden = await postFork(harness, {
          sourceThreadId: source.id,
          providerOptions: { promptCacheTtl: "5m" },
        });
        expect(overridden.status).toBe(201);
        expect(
          threadResponseSchema.parse(await readJson(overridden)).promptCacheTtl,
        ).toBe("5m");

        const emptyBag = await postFork(harness, {
          sourceThreadId: source.id,
          providerOptions: {},
        });
        expect(emptyBag.status).toBe(201);
        const emptyBagFork = threadResponseSchema.parse(
          await readJson(emptyBag),
        );
        expect(emptyBagFork.promptCacheTtl).toBe("1h");
        expect(getThread(harness.db, emptyBagFork.id)?.promptCacheTtl).toBe(
          "1h",
        );
      });
    });

    it("leaves a fork of a thread without a value unchanged", async () => {
      await withTestHarness(async (harness) => {
        const source = seedSource(harness, null);

        const response = await postFork(harness, { sourceThreadId: source.id });
        expect(response.status).toBe(201);
        expect(
          threadResponseSchema.parse(await readJson(response)).promptCacheTtl,
        ).toBeNull();
      });
    });

    it("rejects an invalid override", async () => {
      await withTestHarness(async (harness) => {
        const source = seedSource(harness, null);

        const response = await postFork(harness, {
          sourceThreadId: source.id,
          providerOptions: { promptCacheTtl: "2h" },
        });
        expect(response.status).toBe(400);
      });
    });
  });
});
