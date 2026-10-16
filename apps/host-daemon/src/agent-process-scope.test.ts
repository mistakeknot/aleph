import type { AgentCgroupPlacer } from "@bb/provider-bridge-protocol/bridge-kit";
import { describe, expect, it, vi } from "vitest";
import {
  placeAgentProcessInScope,
  prepareAgentProcessScopes,
  wrapAgentProcessSpawn,
} from "./agent-process-scope.js";

function fakePlacer(
  placeInScope: AgentCgroupPlacer["placeInScope"] = async () => undefined,
) {
  return {
    dispose: vi.fn(),
    place: vi.fn(async () => undefined),
    placeInScope: vi.fn(placeInScope),
    prepare: vi.fn(async () => undefined),
    wrapSpawn: vi.fn<AgentCgroupPlacer["wrapSpawn"]>(() => null),
  };
}

const logger = { warn: vi.fn() };

describe("placeAgentProcessInScope", () => {
  it("gives each daemon child its own named scope", () => {
    const placer = fakePlacer();

    placeAgentProcessInScope({
      logger,
      name: "codex",
      pid: 501,
      placer,
      processKind: "provider-worker",
    });
    placeAgentProcessInScope({
      logger,
      name: "acme.tools",
      pid: 502,
      placer,
      processKind: "plugin-worker",
    });
    placeAgentProcessInScope({
      logger,
      name: "",
      pid: 503,
      placer,
      processKind: "terminal",
    });

    expect(placer.placeInScope.mock.calls.map(([call]) => call)).toEqual([
      {
        pid: 501,
        processKind: "provider-worker",
        unit: "bb-provider-worker-codex-501.scope",
      },
      {
        pid: 502,
        processKind: "plugin-worker",
        unit: "bb-plugin-worker-acme_tools-502.scope",
      },
      { pid: 503, processKind: "terminal", unit: "bb-terminal-503.scope" },
    ]);
  });

  it("skips a child that never got a pid", () => {
    const placer = fakePlacer();

    placeAgentProcessInScope({
      logger,
      name: "codex",
      pid: undefined,
      placer,
      processKind: "provider-worker",
    });

    expect(placer.placeInScope).not.toHaveBeenCalled();
  });

  it("places a gated spawn in the unit its gate waits for", () => {
    const placer = fakePlacer();

    placeAgentProcessInScope({
      logger,
      name: "codex",
      pid: 505,
      placer,
      processKind: "provider-worker",
      scopeUnit: "bb-provider-worker-codex-77_1.scope",
    });
    placeAgentProcessInScope({
      logger,
      name: "codex",
      pid: undefined,
      placer,
      processKind: "provider-worker",
      scopeUnit: "bb-provider-worker-codex-77_2.scope",
    });

    expect(placer.placeInScope.mock.calls.map(([call]) => call)).toEqual([
      {
        pid: 505,
        processKind: "provider-worker",
        unit: "bb-provider-worker-codex-77_1.scope",
      },
      {
        pid: undefined,
        processKind: "provider-worker",
        unit: "bb-provider-worker-codex-77_2.scope",
      },
    ]);
  });

  it("never lets a placement failure reach the caller", async () => {
    const placer = fakePlacer(async () => {
      throw new Error("bus went away");
    });

    expect(() =>
      placeAgentProcessInScope({
        logger,
        name: "",
        pid: 504,
        placer,
        processKind: "terminal",
      }),
    ).not.toThrow();
    await Promise.resolve();
    expect(placer.placeInScope).toHaveBeenCalledTimes(1);
  });
});

describe("wrapAgentProcessSpawn", () => {
  it("hands the spawn to the placer and returns its wrapped command", () => {
    const placer = fakePlacer();
    placer.wrapSpawn.mockReturnValue({
      args: ["-c", 'exec "$@"', "bb-agent-gate", "/bin/bash"],
      command: "/usr/bin/sh",
      env: {},
      scopeUnit: "bb-terminal-77_1.scope",
    });

    const wrapped = wrapAgentProcessSpawn({
      args: [],
      command: "/bin/bash",
      env: {},
      logger,
      name: "",
      placer,
      processKind: "terminal",
    });

    expect(placer.wrapSpawn).toHaveBeenCalledWith({
      args: [],
      command: "/bin/bash",
      env: {},
      name: "",
      processKind: "terminal",
    });
    expect(wrapped?.scopeUnit).toBe("bb-terminal-77_1.scope");
  });
});

describe("prepareAgentProcessScopes", () => {
  it("never rejects", async () => {
    const placer = fakePlacer();
    placer.prepare.mockRejectedValue(new Error("bus went away"));

    await expect(
      prepareAgentProcessScopes({ logger, placer }),
    ).resolves.toBeUndefined();
  });
});
