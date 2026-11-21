import { describe, expect, it } from "vitest";
import {
  getThread,
  getThreadPromptCacheTtl,
  upsertProjectExecutionDefaults,
} from "@bb/db";
import { encodeClientTurnRequestIdNumber } from "@bb/domain";
import { hostDaemonCommandSchema } from "@bb/host-daemon-contract";
import {
  buildExecutionOptions,
  buildThreadStartCommand,
} from "../../src/services/threads/thread-commands.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
  seedThreadRuntimeState,
  seedTurnStarted,
} from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";
import { textInput } from "../helpers/prompt-input.js";

const headers = { "content-type": "application/json" };
describe("per-thread prompt cache TTL", () => {
  it("persists creation, isolates siblings, and survives resume and fork", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const create = async (execution?: { promptCacheTtl: "1h" }) => {
        const response = await harness.app.request("/api/v1/threads", {
          method: "POST",
          headers,
          body: JSON.stringify({
            origin: "sdk",
            projectId: project.id,
            providerId: "claude-code",
            model: "claude-sonnet-5",
            environment: { type: "reuse", environmentId: environment.id },
            input: textInput("hello"),
            sendAt: Date.now() + 3600000,
            execution,
          }),
        });
        expect(response.status, await response.clone().text()).toBe(201);
        const body = await response.json();
        const thread = getThread(harness.db, body.id);
        expect(thread).not.toBeNull();
        return thread!;
      };
      upsertProjectExecutionDefaults(harness.db, {
        projectId: project.id,
        providerId: "claude-code",
        model: "claude-sonnet-5",
        permissionMode: "full",
        reasoningLevel: "medium",
        serviceTier: "default",
      });
      const selected = await create({ promptCacheTtl: "1h" });
      const sibling = await create();
      const start = async (thread: typeof selected) => {
        const execution = await buildExecutionOptions(
          harness.deps,
          {},
          { threadId: thread.id },
        );
        const command = await buildThreadStartCommand(harness.deps, {
          thread,
          environment,
          execution,
          fork: null,
          permissionEscalation: "ask",
          input: textInput("resume"),
          projectId: project.id,
          providerId: "claude-code",
          requestId: encodeClientTurnRequestIdNumber({ value: 1 }),
          syncGeneratedTitle: false,
        });
        expect(hostDaemonCommandSchema.safeParse(command).success).toBe(true);
        return command.options.providerOptions;
      };
      expect(await start(selected)).toHaveProperty("promptCacheTtl", "1h");
      expect(await start(sibling)).not.toHaveProperty("promptCacheTtl");
      expect(await start(selected)).toHaveProperty("promptCacheTtl", "1h");
      seedThreadRuntimeState(harness.deps, {
        environmentId: environment.id,
        model: "claude-sonnet-5",
        providerThreadId: "provider-cache-source",
        threadId: selected.id,
      });
      seedTurnStarted(harness.deps, {
        environmentId: environment.id,
        providerThreadId: "provider-cache-source",
        threadId: selected.id,
        turnId: "cache-source-turn",
      });
      const response = await harness.app.request("/api/v1/threads/fork", {
        method: "POST",
        headers,
        body: JSON.stringify({ sourceThreadId: selected.id }),
      });
      expect(response.status, await response.clone().text()).toBe(201);
      const fork = await response.json();
      expect(getThreadPromptCacheTtl(harness.db, fork.id)).toBe("1h");
      const forkThread = getThread(harness.db, fork.id);
      expect(forkThread).not.toBeNull();
      expect(await start(forkThread!)).toHaveProperty("promptCacheTtl", "1h");
    });
  });
  it("accepts a start option and leaves other providers' options unset", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        providerId: "codex",
      });
      upsertProjectExecutionDefaults(harness.db, {
        projectId: project.id,
        providerId: "codex",
        model: "gpt-5",
        permissionMode: "full",
        reasoningLevel: "medium",
        serviceTier: "default",
      });
      await buildExecutionOptions(
        harness.deps,
        { execution: { promptCacheTtl: "5m" } },
        { threadId: thread.id },
      );
      const execution = await buildExecutionOptions(
        harness.deps,
        {},
        { threadId: thread.id },
      );
      expect(execution.promptCacheTtl).toBe("5m");
      const command = await buildThreadStartCommand(harness.deps, {
        thread,
        environment,
        execution,
        fork: null,
        permissionEscalation: "ask",
        input: textInput("start"),
        projectId: project.id,
        providerId: "codex",
        requestId: encodeClientTurnRequestIdNumber({ value: 1 }),
        syncGeneratedTitle: false,
      });
      expect(command.options.providerOptions).not.toHaveProperty(
        "promptCacheTtl",
      );
    });
  });
  it.each([
    "/api/v1/threads",
    "/api/v1/threads/fork",
    "/api/v1/threads/thread/send",
  ])("rejects invalid TTL at %s", async (path) => {
    await withTestHarness(async (harness) => {
      const response = await harness.app.request(path, {
        method: "POST",
        headers,
        body: JSON.stringify({
          projectId: "project",
          sourceThreadId: "thread",
          origin: "sdk",
          mode: "start",
          environment: { type: "reuse", environmentId: "environment" },
          input: textInput("hello"),
          execution: { promptCacheTtl: "2h" },
        }),
      });
      expect(response.status).toBe(400);
      expect(await response.text()).toContain("promptCacheTtl");
    });
  });
});
