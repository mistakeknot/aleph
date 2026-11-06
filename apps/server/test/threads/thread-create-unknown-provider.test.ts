import { threads, upsertProjectExecutionDefaults } from "@bb/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProviderRegistryService } from "../../src/services/providers/provider-registry.js";
import { registerFirstPartyProviders } from "../helpers/provider-registry.js";
import { readJson } from "../helpers/json.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
} from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";
import { installFakeGitWorktreeProvider } from "../helpers/environment-provider.js";

function seedWorkspace(harness: TestAppHarness) {
  const { host } = seedHostSession(harness.deps, { id: "host-unknown-prov" });
  const { project } = seedProjectWithSource(harness.deps, {
    hostId: host.id,
    path: "/tmp/unknown-provider-project",
  });
  seedEnvironment(harness.deps, {
    hostId: host.id,
    projectId: project.id,
    path: "/tmp/unknown-provider-workspace",
    status: "ready",
  });
  installFakeGitWorktreeProvider(() => ({
    action: "ready",
    environment: {
      type: "host",
      hostId: host.id,
      path: "/tmp/unknown-provider-workspace",
    },
  }));
  return { host, project };
}

function createThread(
  harness: TestAppHarness,
  args: {
    hostId: string;
    model?: string;
    projectId: string;
    providerId: string;
  },
) {
  return harness.app.request("/api/v1/threads", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      origin: "app",
      projectId: args.projectId,
      providerId: args.providerId,
      ...(args.model !== undefined ? { model: args.model } : {}),
      input: [{ type: "text", text: "Start" }],
      environment: {
        type: "host",
        hostId: args.hostId,
        workspace: {
          type: "managed-worktree",
          baseBranch: { kind: "default" },
        },
      },
    }),
  });
}

describe("thread create with an unregistered provider id", () => {
  it("rejects the request, lists the valid provider ids and creates no thread", async () => {
    await withTestHarness(async (harness) => {
      const { host, project } = seedWorkspace(harness);

      const response = await createThread(harness, {
        hostId: host.id,
        projectId: project.id,
        providerId: "claude",
      });

      expect(response.status).toBe(400);
      const body = (await readJson(response)) as {
        code?: string;
        message?: string;
      };
      expect(body.code).toBe("unknown_provider");
      expect(body.message).toContain('Unknown provider "claude"');
      expect(body.message).toContain("claude-code");
      expect(body.message).toContain("codex");
      expect(harness.db.select().from(threads).all()).toHaveLength(0);
    });
  });

  it("still creates a thread for a registered provider id", async () => {
    await withTestHarness(async (harness) => {
      const { host, project } = seedWorkspace(harness);

      const response = await createThread(harness, {
        hostId: host.id,
        projectId: project.id,
        providerId: "codex",
      });

      expect(response.status).toBe(201);
      expect(harness.db.select().from(threads).all()).toHaveLength(1);
    });
  });
});

describe("thread create while provider plugins are still registering", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("succeeds when the requested provider registers after the first wait timed out", async () => {
    await withTestHarness(
      { seedFirstPartyProviders: false },
      async (harness) => {
        const registry = createProviderRegistryService({
          deferRegistrationsSettled: true,
        });
        harness.deps.providerRegistry = registry;
        const { host, project } = seedWorkspace(harness);

        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const responsePromise = createThread(harness, {
          hostId: host.id,
          projectId: project.id,
          providerId: "codex",
        });
        await vi.advanceTimersByTimeAsync(30_000);
        expect(registry.registrationsSettled()).toBe(false);
        expect(registry.get("codex")).toBeNull();

        await registerFirstPartyProviders(registry, {
          artifacts: harness.deps.pluginHostArtifacts,
        });
        const response = await responsePromise;

        expect(response.status).toBe(201);
        expect(harness.db.select().from(threads).all()).toHaveLength(1);
      },
    );
  });

  it("answers a retryable 503 only after the second wait for the provider times out", async () => {
    await withTestHarness(
      { seedFirstPartyProviders: false },
      async (harness) => {
        const registry = createProviderRegistryService({
          deferRegistrationsSettled: true,
        });
        const providerWait = vi.spyOn(registry, "whenProviderRegistered");
        harness.deps.providerRegistry = registry;
        const { host, project } = seedWorkspace(harness);

        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        let answered = false;
        const responsePromise = Promise.resolve(
          createThread(harness, {
            hostId: host.id,
            projectId: project.id,
            providerId: "codex",
          }),
        ).then((response) => {
          answered = true;
          return response;
        });
        await vi.advanceTimersByTimeAsync(30_000);
        expect(answered).toBe(false);
        expect(providerWait).toHaveBeenCalledTimes(1);
        expect(providerWait).toHaveBeenCalledWith("codex");

        await vi.advanceTimersByTimeAsync(30_000);
        const response = await responsePromise;

        expect(response.status).toBe(503);
        const body = (await readJson(response)) as {
          code?: string;
          retryable?: boolean;
        };
        expect(body.code).toBe("provider_registration_pending");
        expect(body.retryable).toBe(true);
        expect(harness.db.select().from(threads).all()).toHaveLength(0);
      },
    );
  });

  it("rejects a disabled, not yet registered provider after the first wait without a second wait", async () => {
    await withTestHarness(
      { seedFirstPartyProviders: false },
      async (harness) => {
        const registry = createProviderRegistryService({
          deferRegistrationsSettled: true,
          readUserProviderPreferences: () => ({
            providerOrder: [],
            defaultProviderId: null,
            disabledProviderIds: ["codex"],
          }),
        });
        const providerWait = vi.spyOn(registry, "whenProviderRegistered");
        harness.deps.providerRegistry = registry;
        const { host, project } = seedWorkspace(harness);

        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        let answered = false;
        const responsePromise = Promise.resolve(
          createThread(harness, {
            hostId: host.id,
            projectId: project.id,
            providerId: "codex",
          }),
        ).then((response) => {
          answered = true;
          return response;
        });
        await vi.advanceTimersByTimeAsync(30_000);
        expect(answered).toBe(true);
        const response = await responsePromise;

        expect(response.status).toBe(409);
        const body = (await readJson(response)) as { code?: string };
        expect(body.code).toBe("provider_disabled");
        expect(providerWait).not.toHaveBeenCalled();
        expect(harness.db.select().from(threads).all()).toHaveLength(0);
      },
    );
  });

  it.each([
    {
      name: "a model is supplied",
      prepare: () => ({ model: "supplied-model" }),
    },
    {
      name: "the project's stored defaults match the provider",
      prepare: (harness: TestAppHarness, projectId: string) => {
        upsertProjectExecutionDefaults(harness.db, {
          projectId,
          providerId: "codex",
          model: "stored-model",
          reasoningLevel: "medium",
          permissionMode: "auto",
          serviceTier: "default",
        });
        return {};
      },
    },
  ])(
    "answers the retryable 503 after the first wait without a second wait when $name",
    async ({ prepare }) => {
      await withTestHarness(
        { seedFirstPartyProviders: false },
        async (harness) => {
          const registry = createProviderRegistryService({
            deferRegistrationsSettled: true,
          });
          const providerWait = vi.spyOn(registry, "whenProviderRegistered");
          harness.deps.providerRegistry = registry;
          const { host, project } = seedWorkspace(harness);
          const extra = prepare(harness, project.id);

          vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
          let answered = false;
          const responsePromise = Promise.resolve(
            createThread(harness, {
              hostId: host.id,
              projectId: project.id,
              providerId: "codex",
              ...extra,
            }),
          ).then((response) => {
            answered = true;
            return response;
          });
          await vi.advanceTimersByTimeAsync(30_000);
          expect(answered).toBe(true);
          const response = await responsePromise;

          expect(response.status).toBe(503);
          const body = (await readJson(response)) as {
            code?: string;
            retryable?: boolean;
          };
          expect(body.code).toBe("provider_registration_pending");
          expect(body.retryable).toBe(true);
          expect(providerWait).not.toHaveBeenCalled();
          expect(harness.db.select().from(threads).all()).toHaveLength(0);
        },
      );
    },
  );
});
