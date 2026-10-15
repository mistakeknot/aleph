import { describe, expect, it, vi } from "vitest";
import type { AgentRuntimeProcessSpawnCommand } from "./types.js";
import { createProviderForId } from "./provider-registry.js";
import { RuntimeProviderProcessManager } from "./runtime-provider-process.js";
import { RuntimeThreadIdentityRegistry } from "./runtime-thread-identity.js";
import { createScriptedEchoLaunch } from "./test/runtime-test-harness.js";

const spawned = vi.hoisted(() => ({ count: 0 }));

vi.mock("@bb/process-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@bb/process-utils")>();
  return {
    ...actual,
    spawnManagedProcess: () => {
      spawned.count += 1;
      throw new Error("provider spawned after shutdown");
    },
  };
});

describe("RuntimeProviderProcessManager agent scope wrap", () => {
  it("spawns no provider when shutdown begins while the wrap is pending", async () => {
    let release: (value: AgentRuntimeProcessSpawnCommand | null) => void = () =>
      undefined;
    const pending = new Promise<AgentRuntimeProcessSpawnCommand | null>(
      (resolve) => {
        release = resolve;
      },
    );
    const identityRegistry = new RuntimeThreadIdentityRegistry();
    const bridgeLaunch = createScriptedEchoLaunch();
    const manager = new RuntimeProviderProcessManager({
      additionalWorkspaceWriteRoots: [],
      createAdapter: () =>
        createProviderForId("fake", {
          additionalWorkspaceWriteRoots: [],
          bridgeLaunch,
        }),
      bridgeBundleDir: undefined,
      bridgeNodeExecutablePath: process.execPath,
      captureThreadExitState: (threadId) => ({
        activeTurnId: null,
        pendingTurnStart: false,
        providerThreadId: null,
        threadId,
      }),
      createProviderIdentityState: (providerId) =>
        identityRegistry.createProviderState({ providerId }),
      env: undefined,
      getNextRequestId: () => 1,
      handleStdoutLine: () => undefined,
      onProcessExit: vi.fn(),
      onProviderThreadDetached: () => undefined,
      onStderr: undefined,
      prepareProcessSpawn: () => pending,
      skillRoots: [],
      workspacePath: process.cwd(),
    });
    const start = manager.ensureProvider({
      bridgeLaunch,
      processKey: "fake",
      providerId: "fake",
    });
    await manager.shutdown();
    release({ args: ["bridge.js"], command: "/usr/bin/systemd-run", env: {} });
    await expect(start).resolves.toBeUndefined();
    expect(spawned.count).toBe(0);
    expect(manager.listRunningProviders()).toEqual([]);
  });
});
