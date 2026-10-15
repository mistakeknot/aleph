import { describe, expect, it } from "vitest";
import {
  agentScopeUnitName,
  agentSlicePropertyArgs,
  createAgentCgroupPlacer,
  DEFAULT_AGENT_CPU_WEIGHT,
  DEFAULT_AGENT_SLICE,
  ownSystemdUserUnit,
  resolveAgentCgroupConfig,
  startAgentScopeArgs,
  type AgentCgroupConfig,
  type AgentCgroupDeps,
} from "./agent-cgroup-scope.js";

const DAEMON_CGROUP =
  "0::/user.slice/user-1000.slice/user@1000.service/app.slice/bb-host-daemon.service\n";

const CONFIG: AgentCgroupConfig = {
  slice: DEFAULT_AGENT_SLICE,
  cpuWeight: DEFAULT_AGENT_CPU_WEIGHT,
  cpuQuota: null,
};

function enabled(env: NodeJS.ProcessEnv): AgentCgroupConfig | null {
  return resolveAgentCgroupConfig({
    env: { BB_AGENT_CGROUP: "systemd", ...env },
    platform: "linux",
  });
}

describe("resolveAgentCgroupConfig", () => {
  it("is off unless the daemon opts in on Linux", () => {
    expect(resolveAgentCgroupConfig({ env: {}, platform: "linux" })).toBe(null);
    expect(
      resolveAgentCgroupConfig({
        env: { BB_AGENT_CGROUP: "0" },
        platform: "linux",
      }),
    ).toBe(null);
    for (const platform of ["darwin", "win32", "freebsd"] as const) {
      expect(
        resolveAgentCgroupConfig({
          env: { BB_AGENT_CGROUP: "systemd" },
          platform,
        }),
      ).toBe(null);
    }
  });

  it("uses the defaults when only the mode is set", () => {
    expect(enabled({})).toEqual(CONFIG);
    expect(enabled({ BB_AGENT_CGROUP: " SystemD " })).toEqual(CONFIG);
  });

  it("accepts a custom slice, weight and quota", () => {
    expect(
      enabled({
        BB_AGENT_CGROUP_SLICE: "agents.slice",
        BB_AGENT_CPU_WEIGHT: "50",
        BB_AGENT_CPU_QUOTA: "800%",
      }),
    ).toEqual({ slice: "agents.slice", cpuWeight: 50, cpuQuota: "800%" });
  });

  it("falls back to the defaults for invalid values", () => {
    for (const slice of [
      "agents",
      "../agents.slice",
      "agents slice.slice",
      "-agents.slice",
      "agents--x.slice",
      `${"a".repeat(255)}.slice`,
    ]) {
      expect(enabled({ BB_AGENT_CGROUP_SLICE: slice })?.slice).toBe(
        DEFAULT_AGENT_SLICE,
      );
    }
    for (const weight of ["0", "10001", "-5", "1.5", "lots"]) {
      expect(enabled({ BB_AGENT_CPU_WEIGHT: weight })?.cpuWeight).toBe(
        DEFAULT_AGENT_CPU_WEIGHT,
      );
    }
    for (const quota of ["0%", "800", "8 cpus", "-1%", "1.5%"]) {
      expect(enabled({ BB_AGENT_CPU_QUOTA: quota })?.cpuQuota).toBe(null);
    }
  });
});

describe("agentScopeUnitName", () => {
  it("names one scope per agent process", () => {
    expect(agentScopeUnitName({ pid: 4242, threadId: "thr_abc123" })).toBe(
      "bb-agent-thr_abc123-4242.scope",
    );
  });

  it("keeps unit names valid for any thread id", () => {
    expect(agentScopeUnitName({ pid: 7, threadId: "thr/../x y.z\\" })).toBe(
      "bb-agent-thr____x_y_z_-7.scope",
    );
    expect(agentScopeUnitName({ pid: 7, threadId: "t".repeat(500) })).toBe(
      `bb-agent-${"t".repeat(64)}-7.scope`,
    );
  });
});

describe("ownSystemdUserUnit", () => {
  it("finds the daemon's unit under the user manager", () => {
    expect(ownSystemdUserUnit(DAEMON_CGROUP)).toBe("bb-host-daemon.service");
    expect(
      ownSystemdUserUnit(
        "0::/user.slice/user-1000.slice/user@1000.service/app.slice/run-u12.scope",
      ),
    ).toBe("run-u12.scope");
  });

  it("ignores cgroup v1 controller lines", () => {
    expect(
      ownSystemdUserUnit(`12:cpu,cpuacct:/user.slice\n${DAEMON_CGROUP}`),
    ).toBe("bb-host-daemon.service");
  });

  it("rejects processes the user manager does not own", () => {
    for (const cgroup of [
      "",
      "0::/",
      "0::/user.slice/user-1000.slice/session-3.scope",
      "0::/system.slice/bb.service",
      "0::/user.slice/user-1000.slice/user@1000.service",
      "0::/user.slice/user-1000.slice/user@1000.service/app.slice",
      "12:cpu:/user.slice/user-1000.slice/user@1000.service/app.slice/bb.service",
    ]) {
      expect(ownSystemdUserUnit(cgroup)).toBe(null);
    }
  });
});

describe("systemd command lines", () => {
  it("configures the agent slice and clears an old quota when unset", () => {
    expect(agentSlicePropertyArgs(CONFIG)).toEqual([
      "--user",
      "set-property",
      "--runtime",
      "bb_agents.slice",
      "CPUWeight=20",
      "CPUQuota=",
    ]);
    expect(agentSlicePropertyArgs({ ...CONFIG, cpuQuota: "400%" }).at(-1)).toBe(
      "CPUQuota=400%",
    );
  });

  it("adopts the agent into a scope bound to the daemon unit", () => {
    expect(
      startAgentScopeArgs({
        bindsTo: "bb-host-daemon.service",
        pid: 4242,
        slice: "bb_agents.slice",
        unit: "bb-agent-thr_1-4242.scope",
      }),
    ).toEqual([
      "--user",
      "call",
      "org.freedesktop.systemd1",
      "/org/freedesktop/systemd1",
      "org.freedesktop.systemd1.Manager",
      "StartTransientUnit",
      "ssa(sv)a(sa(sv))",
      "bb-agent-thr_1-4242.scope",
      "fail",
      "3",
      "PIDs",
      "au",
      "1",
      "4242",
      "Slice",
      "s",
      "bb_agents.slice",
      "BindsTo",
      "as",
      "1",
      "bb-host-daemon.service",
      "0",
    ]);
  });
});

function fakeDeps(overrides: Partial<AgentCgroupDeps> = {}) {
  const calls: Array<{ command: string; args: string[] }> = [];
  const warnings: string[] = [];
  const deps: AgentCgroupDeps = {
    isAlive: () => true,
    readOwnCgroup: () => DAEMON_CGROUP,
    run: async (command, args) => {
      calls.push({ command, args });
    },
    warn: (message) => {
      warnings.push(message);
    },
    ...overrides,
  };
  return { calls, deps, warnings };
}

function commandError(code: string | number, stderr = ""): Error {
  return Object.assign(new Error(`failed with ${code}`), { code, stderr });
}

describe("createAgentCgroupPlacer", () => {
  it("configures the slice once and gives each agent process a scope", async () => {
    const { calls, deps, warnings } = fakeDeps();
    const placer = createAgentCgroupPlacer({ config: CONFIG, deps });

    await Promise.all([
      placer.place({ pid: 101, threadId: "thr_a" }),
      placer.place({ pid: 102, threadId: "thr_b" }),
    ]);

    expect(calls.map((call) => call.command)).toEqual([
      "systemctl",
      "busctl",
      "busctl",
    ]);
    expect(calls[0]?.args).toEqual(agentSlicePropertyArgs(CONFIG));
    expect(calls[1]?.args).toContain("bb-agent-thr_a-101.scope");
    expect(calls[2]?.args).toContain("bb-agent-thr_b-102.scope");
    expect(calls[1]?.args).toContain("bb-host-daemon.service");
    expect(warnings).toEqual([]);
  });

  it("does nothing when isolation is off", async () => {
    const { calls, deps, warnings } = fakeDeps();
    const placer = createAgentCgroupPlacer({ config: null, deps });

    await placer.place({ pid: 101, threadId: "thr_a" });

    expect(calls).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("skips processes without a pid or a thread", async () => {
    const { calls, deps } = fakeDeps();
    const placer = createAgentCgroupPlacer({ config: CONFIG, deps });

    await placer.place({ pid: undefined, threadId: "thr_a" });
    await placer.place({ pid: 101, threadId: null });

    expect(calls).toEqual([]);
  });

  it("falls back when the bridge is not under the systemd user manager", async () => {
    const { calls, deps, warnings } = fakeDeps({
      readOwnCgroup: () => "0::/user.slice/user-1000.slice/session-3.scope\n",
    });
    const placer = createAgentCgroupPlacer({ config: CONFIG, deps });

    await placer.place({ pid: 101, threadId: "thr_a" });
    await placer.place({ pid: 102, threadId: "thr_b" });

    expect(calls).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("not running under the systemd user manager");
  });

  it("falls back when /proc is unreadable", async () => {
    const { calls, deps, warnings } = fakeDeps({ readOwnCgroup: () => null });
    const placer = createAgentCgroupPlacer({ config: CONFIG, deps });

    await placer.place({ pid: 101, threadId: "thr_a" });

    expect(calls).toEqual([]);
    expect(warnings).toHaveLength(1);
  });

  it("falls back when the slice cannot be configured", async () => {
    const { calls, deps, warnings } = fakeDeps({
      run: async (command, args) => {
        calls.push({ command, args });
        throw commandError(1, "Failed to connect to bus: No medium found");
      },
    });
    const placer = createAgentCgroupPlacer({ config: CONFIG, deps });

    await placer.place({ pid: 101, threadId: "thr_a" });
    await placer.place({ pid: 102, threadId: "thr_b" });

    expect(calls.map((call) => call.command)).toEqual(["systemctl"]);
    expect(warnings).toEqual([
      "Agent CPU isolation is off for this provider process: could not configure bb_agents.slice (Failed to connect to bus: No medium found). Agents keep running in the host daemon's cgroup.",
    ]);
  });

  it("falls back when systemctl is missing", async () => {
    const { deps, warnings } = fakeDeps({
      run: async () => {
        throw commandError("ENOENT");
      },
    });
    const placer = createAgentCgroupPlacer({ config: CONFIG, deps });

    await placer.place({ pid: 101, threadId: "thr_a" });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("systemctl is not available");
  });

  it("falls back when busctl is missing", async () => {
    const { calls, deps, warnings } = fakeDeps({
      run: async (command, args) => {
        calls.push({ command, args });
        if (command === "busctl") throw commandError("ENOENT");
      },
    });
    const placer = createAgentCgroupPlacer({ config: CONFIG, deps });

    await placer.place({ pid: 101, threadId: "thr_a" });
    await placer.place({ pid: 102, threadId: "thr_b" });

    expect(calls.map((call) => call.command)).toEqual(["systemctl", "busctl"]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("busctl is not available");
  });

  it("ignores agents that exit before they are adopted", async () => {
    const { deps, warnings } = fakeDeps({
      isAlive: () => false,
      run: async (command) => {
        if (command === "busctl") throw commandError(1, "No such process");
      },
    });
    const placer = createAgentCgroupPlacer({ config: CONFIG, deps });

    for (let pid = 101; pid < 110; pid += 1) {
      await placer.place({ pid, threadId: "thr_a" });
    }

    expect(warnings).toEqual([]);
  });

  it("turns itself off after repeated placement failures", async () => {
    const { calls, deps, warnings } = fakeDeps({
      run: async (command, args) => {
        calls.push({ command, args });
        if (command === "busctl") throw commandError(1, "Access denied");
      },
    });
    const placer = createAgentCgroupPlacer({ config: CONFIG, deps });

    for (let pid = 101; pid < 106; pid += 1) {
      await placer.place({ pid, threadId: "thr_a" });
    }

    expect(calls.filter((call) => call.command === "busctl")).toHaveLength(3);
    expect(warnings).toEqual([
      "Could not move agent process 101 into bb_agents.slice (Access denied).",
      "Could not move agent process 102 into bb_agents.slice (Access denied).",
      "Could not move agent process 103 into bb_agents.slice (Access denied).",
      "Agent CPU isolation is off for this provider process: 3 placements in a row failed. Agents keep running in the host daemon's cgroup.",
    ]);
  });

  it("resets the failure count after a successful placement", async () => {
    let failNext = [true, true, false, true, true, false];
    const { deps, warnings } = fakeDeps({
      run: async (command) => {
        if (command !== "busctl") return;
        const fail = failNext[0];
        failNext = failNext.slice(1);
        if (fail) throw commandError(1, "busy");
      },
    });
    const placer = createAgentCgroupPlacer({ config: CONFIG, deps });

    for (let pid = 101; pid < 107; pid += 1) {
      await placer.place({ pid, threadId: "thr_a" });
    }

    expect(warnings).toHaveLength(4);
    expect(warnings.join("\n")).not.toContain("isolation is off");
  });
});
