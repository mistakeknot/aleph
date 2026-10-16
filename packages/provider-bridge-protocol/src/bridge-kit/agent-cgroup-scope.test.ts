import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  agentProcessScopeUnitName,
  agentScopeUnitName,
  agentSlicePropertyArgs,
  createAgentCgroupPlacer,
  DEFAULT_AGENT_CPU_WEIGHT,
  DEFAULT_AGENT_SLICE,
  ownSystemdUserUnit,
  resolveAgentCgroupConfig,
  placementGateArgs,
  PLACEMENT_GATE_NAME,
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
  memoryHigh: null,
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

  it("accepts a custom slice, weight, quota and memory ceiling", () => {
    expect(
      enabled({
        BB_AGENT_CGROUP_SLICE: "agents.slice",
        BB_AGENT_CPU_WEIGHT: "50",
        BB_AGENT_CPU_QUOTA: "800%",
        BB_AGENT_MEMORY_HIGH: "48G",
      }),
    ).toEqual({
      slice: "agents.slice",
      cpuWeight: 50,
      cpuQuota: "800%",
      memoryHigh: "48G",
    });
    for (const memoryHigh of ["1073741824", "512M", "2T", "75%", "100%"]) {
      expect(enabled({ BB_AGENT_MEMORY_HIGH: memoryHigh })?.memoryHigh).toBe(
        memoryHigh,
      );
    }
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
    for (const memoryHigh of [
      "0",
      "0G",
      "48GB",
      "48g",
      "0%",
      "101%",
      "1.5G",
      "-1G",
      "infinity",
    ]) {
      expect(enabled({ BB_AGENT_MEMORY_HIGH: memoryHigh })?.memoryHigh).toBe(
        null,
      );
    }
  });
});

describe("agentProcessScopeUnitName", () => {
  it("names one scope per daemon child process", () => {
    expect(
      agentProcessScopeUnitName({
        kind: "provider-worker",
        name: "codex",
        pid: 4242,
      }),
    ).toBe("bb-provider-worker-codex-4242.scope");
    expect(
      agentProcessScopeUnitName({
        kind: "plugin-worker",
        name: "@acme/plugin.x",
        pid: 7,
      }),
    ).toBe("bb-plugin-worker-_acme_plugin_x-7.scope");
  });

  it("leaves out an empty name", () => {
    expect(
      agentProcessScopeUnitName({ kind: "terminal", name: "", pid: 9 }),
    ).toBe("bb-terminal-9.scope");
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
  it("configures the agent slice and clears old limits when unset", () => {
    expect(agentSlicePropertyArgs(CONFIG)).toEqual([
      "--user",
      "set-property",
      "--runtime",
      "agents.slice",
      "CPUWeight=20",
      "CPUQuota=",
      "MemoryHigh=infinity",
    ]);
    expect(
      agentSlicePropertyArgs({
        ...CONFIG,
        cpuQuota: "400%",
        memoryHigh: "48G",
      }).slice(-2),
    ).toEqual(["CPUQuota=400%", "MemoryHigh=48G"]);
  });

  it("adopts the agent into a scope bound to the daemon unit", () => {
    expect(
      startAgentScopeArgs({
        bindsTo: "bb-host-daemon.service",
        pid: 4242,
        slice: "agents.slice",
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
      "agents.slice",
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
    resolveCommand: (name) => `/usr/bin/${name}`,
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
      "Agent CPU isolation is off for this provider process: could not configure agents.slice (Failed to connect to bus: No medium found). Its child processes keep running in its own cgroup.",
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
      "Could not move agent process 101 into agents.slice (Access denied). Later placement failures are not logged; after 3 in a row, isolation turns off.",
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

    expect(warnings).toHaveLength(1);
    expect(warnings.join("\n")).not.toContain("isolation is off");
  });

  it("places a daemon child in the scope it is given", async () => {
    const { calls, deps, warnings } = fakeDeps();
    const placer = createAgentCgroupPlacer({
      config: CONFIG,
      deps,
      owner: "the host daemon",
    });

    await placer.placeInScope({
      pid: 301,
      processKind: "provider-worker",
      unit: "bb-provider-worker-codex-301.scope",
    });
    await placer.placeInScope({
      pid: undefined,
      processKind: "terminal",
      unit: "bb-terminal-0.scope",
    });

    expect(calls.map((call) => call.command)).toEqual(["systemctl", "busctl"]);
    expect(calls[1]?.args).toEqual(
      startAgentScopeArgs({
        bindsTo: "bb-host-daemon.service",
        pid: 301,
        slice: "agents.slice",
        unit: "bb-provider-worker-codex-301.scope",
      }),
    );
    expect(warnings).toEqual([]);
  });

  it("names the owner and process kind in its warnings", async () => {
    const { deps, warnings } = fakeDeps({
      run: async (command) => {
        if (command === "busctl") throw commandError(1, "Access denied");
      },
    });
    const placer = createAgentCgroupPlacer({
      config: CONFIG,
      deps,
      owner: "the host daemon",
    });

    for (let pid = 301; pid < 304; pid += 1) {
      await placer.placeInScope({
        pid,
        processKind: "terminal",
        unit: `bb-terminal-${pid}.scope`,
      });
    }

    expect(warnings).toEqual([
      "Could not move terminal 301 into agents.slice (Access denied). Later placement failures are not logged; after 3 in a row, isolation turns off.",
    ]);
  });

  it("binds agent scopes to the provider worker's own scope", async () => {
    const { calls, deps } = fakeDeps({
      readOwnCgroup: () =>
        "0::/user.slice/user-1000.slice/user@1000.service/agents.slice/bb-provider-worker-codex-301.scope\n",
    });
    const placer = createAgentCgroupPlacer({ config: CONFIG, deps });

    await placer.place({ pid: 401, threadId: "thr_a" });

    expect(calls[1]?.args).toEqual(
      startAgentScopeArgs({
        bindsTo: "bb-provider-worker-codex-301.scope",
        pid: 401,
        slice: "agents.slice",
        unit: "bb-agent-thr_a-401.scope",
      }),
    );
  });

  it("does not call busctl once disposed while setup is pending", async () => {
    let releaseSetup: () => void = () => undefined;
    const { calls, deps, warnings } = fakeDeps({
      run: async (command, args) => {
        calls.push({ command, args });
        if (command === "systemctl") {
          await new Promise<void>((resolve) => {
            releaseSetup = resolve;
          });
        }
      },
    });
    const placer = createAgentCgroupPlacer({ config: CONFIG, deps });

    const placing = placer.placeInScope({
      pid: 301,
      processKind: "terminal",
      unit: "bb-terminal-301.scope",
    });
    await Promise.resolve();
    placer.dispose();
    releaseSetup();
    await placing;
    await placer.place({ pid: 302, threadId: "thr_a" });

    expect(calls.map((call) => call.command)).toEqual(["systemctl"]);
    expect(warnings).toEqual([]);
  });

  it("gates spawns once the slice is configured", async () => {
    const { calls, deps, warnings } = fakeDeps();
    const placer = createAgentCgroupPlacer({
      config: CONFIG,
      deps,
      owner: "the host daemon",
    });
    const spawn = {
      args: ["bridge.js", "${HOME}"],
      command: "/usr/bin/node",
      env: { PATH: "/usr/bin", XDG_RUNTIME_DIR: "/run/user/1000" },
      name: "codex",
      processKind: "provider-worker",
    };

    expect(placer.wrapSpawn(spawn)).toBe(null);

    await Promise.all([placer.prepare(), placer.prepare()]);
    const wrapped = placer.wrapSpawn(spawn);

    expect(calls.map((call) => call.command)).toEqual(["systemctl"]);
    expect(wrapped?.command).toBe("/usr/bin/sh");
    expect(wrapped?.scopeUnit).toMatch(
      /^bb-provider-worker-codex-\d+_\d+\.scope$/,
    );
    expect(wrapped?.args).toEqual(
      placementGateArgs({
        args: ["bridge.js", "${HOME}"],
        command: "/usr/bin/node",
        sleep: "/usr/bin/sleep",
        unit: wrapped?.scopeUnit ?? "",
      }),
    );
    expect(wrapped?.args.slice(2, 4)).toEqual([
      PLACEMENT_GATE_NAME,
      wrapped?.scopeUnit,
    ]);
    expect(wrapped?.env).toEqual(spawn.env);
    expect(warnings).toEqual([]);
  });

  it("places a gated spawn in its own scope", async () => {
    const { calls, deps } = fakeDeps();
    const placer = createAgentCgroupPlacer({ config: CONFIG, deps });
    await placer.prepare();
    const wrapped = placer.wrapSpawn({
      args: [],
      command: "/bin/bash",
      env: {},
      name: "",
      processKind: "terminal",
    });

    await placer.placeInScope({
      pid: 4242,
      processKind: "terminal",
      unit: wrapped?.scopeUnit ?? "",
    });

    expect(calls[1]).toEqual({
      command: "busctl",
      args: startAgentScopeArgs({
        bindsTo: "bb-host-daemon.service",
        pid: 4242,
        slice: "agents.slice",
        unit: wrapped?.scopeUnit ?? "",
      }),
    });
  });

  it("stops gating after a gated placement fails", async () => {
    const { deps, warnings } = fakeDeps({
      run: async (command) => {
        if (command === "busctl") {
          throw commandError(1, "Connection timed out");
        }
      },
    });
    const placer = createAgentCgroupPlacer({
      config: CONFIG,
      deps,
      owner: "the host daemon",
    });
    const spawn = {
      args: [],
      command: "/bin/bash",
      env: {},
      name: "",
      processKind: "terminal",
    };
    await placer.prepare();

    await placer.placeInScope({
      pid: 4242,
      processKind: "terminal",
      unit: "bb-terminal-4242.scope",
    });
    const wrapped = placer.wrapSpawn(spawn);
    expect(wrapped).not.toBe(null);

    await placer.placeInScope({
      pid: 4243,
      processKind: "terminal",
      unit: wrapped?.scopeUnit ?? "",
    });

    expect(placer.wrapSpawn(spawn)).toBe(null);
    expect(warnings).toContain(
      "Processes started by the host daemon now join agents.slice after they start, until it restarts: a gated placement failed (Connection timed out).",
    );
  });

  it("leaves spawns ungated when sh or sleep is missing", async () => {
    for (const missing of ["sh", "sleep"]) {
      const { calls, deps, warnings } = fakeDeps({
        resolveCommand: (name) =>
          name === missing ? null : `/usr/bin/${name}`,
      });
      const placer = createAgentCgroupPlacer({ config: CONFIG, deps });

      await placer.prepare();

      expect(
        placer.wrapSpawn({
          args: [],
          command: "/bin/bash",
          env: {},
          name: "",
          processKind: "terminal",
        }),
      ).toBe(null);
      expect(calls.map((call) => call.command)).toEqual(["systemctl"]);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain(`${missing} is not available`);
    }
  });

  it("leaves commands that sh could read as options ungated", async () => {
    const { deps } = fakeDeps();
    const placer = createAgentCgroupPlacer({ config: CONFIG, deps });
    await placer.prepare();

    for (const command of ["", "-bash"]) {
      expect(
        placer.wrapSpawn({
          args: [],
          command,
          env: {},
          name: "",
          processKind: "terminal",
        }),
      ).toBe(null);
    }
  });

  it("stops gating once disposed", async () => {
    let releaseSetUp: () => void = () => undefined;
    const { deps } = fakeDeps({
      run: async (command) => {
        if (command === "systemctl") {
          await new Promise<void>((resolve) => {
            releaseSetUp = resolve;
          });
        }
      },
    });
    const spawn = {
      args: [],
      command: "/bin/bash",
      env: {},
      name: "",
      processKind: "terminal",
    };
    const pending = createAgentCgroupPlacer({ config: CONFIG, deps });
    const preparing = pending.prepare();
    await new Promise((resolve) => setImmediate(resolve));
    pending.dispose();
    releaseSetUp();
    await preparing;
    expect(pending.wrapSpawn(spawn)).toBe(null);

    const ready = createAgentCgroupPlacer({
      config: CONFIG,
      deps: fakeDeps().deps,
    });
    await ready.prepare();
    expect(ready.wrapSpawn(spawn)).not.toBe(null);
    ready.dispose();
    expect(ready.wrapSpawn(spawn)).toBe(null);
  });

  it.runIf(process.platform === "linux")(
    "runs the command with its arguments unchanged once placed or timed out",
    () => {
      const ownLine =
        readFileSync("/proc/self/cgroup", "utf8")
          .split("\n")
          .find((line) => line.startsWith("0::")) ?? "";
      const ownLeaf = ownLine.slice(ownLine.lastIndexOf("/") + 1);
      const args = ["%s|", "a b", "${HOME}", "-x", "it's"];
      const run = (unit: string): { ms: number; out: string } => {
        const started = Date.now();
        const out = execFileSync(
          "/bin/sh",
          placementGateArgs({
            args,
            command: "printf",
            sleep: "sleep",
            unit,
          }),
          { encoding: "utf8" },
        );
        return { ms: Date.now() - started, out };
      };

      const placed = run(ownLeaf);
      expect(placed.out).toBe("a b|${HOME}|-x|it's|");
      expect(placed.ms).toBeLessThan(1_000);

      const timedOut = run("bb-never-placed.scope");
      expect(timedOut.out).toBe("a b|${HOME}|-x|it's|");
      expect(timedOut.ms).toBeGreaterThanOrEqual(1_500);
    },
  );

  it("does nothing before or after prepare when isolation is off", async () => {
    const { calls, deps, warnings } = fakeDeps();
    const placer = createAgentCgroupPlacer({ config: null, deps });

    await placer.prepare();

    expect(
      placer.wrapSpawn({
        args: [],
        command: "/bin/sh",
        env: {},
        name: "",
        processKind: "terminal",
      }),
    ).toBe(null);
    expect(calls).toEqual([]);
    expect(warnings).toEqual([]);
  });
});
