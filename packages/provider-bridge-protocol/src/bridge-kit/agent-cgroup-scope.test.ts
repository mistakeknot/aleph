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
  runInAgentScopeArgs,
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
    busEnv: () => ({ XDG_RUNTIME_DIR: "/run/user/1000" }),
    busReachable: () => true,
    isAlive: () => true,
    now: () => 0,
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

  it("wraps spawns in a scope once systemd-run works", async () => {
    const { calls, deps, warnings } = fakeDeps();
    const placer = createAgentCgroupPlacer({
      config: CONFIG,
      deps,
      owner: "the host daemon",
    });

    expect(
      placer.wrapSpawn({
        args: ["-l"],
        command: "/bin/sh",
        env: {},
        name: "",
        processKind: "terminal",
      }),
    ).toBe(null);

    await Promise.all([placer.prepare(), placer.prepare()]);
    const wrapped = placer.wrapSpawn({
      args: ["bridge.js"],
      command: "/usr/bin/node",
      env: { PATH: "/usr/bin", XDG_RUNTIME_DIR: "/run/user/1000" },
      name: "codex",
      processKind: "provider-worker",
    });

    expect(calls.map((call) => call.command)).toEqual([
      "systemctl",
      "/usr/bin/systemd-run",
    ]);
    expect(calls[1]?.args.slice(-2)).toEqual(["--", "true"]);
    expect(wrapped?.command).toBe("/usr/bin/systemd-run");
    expect(wrapped?.args).toContain("--expand-environment=no");
    const unit = wrapped?.args[5]?.slice("--unit=".length) ?? "";
    expect(unit).toMatch(/^bb-provider-worker-codex-\d+_\d+\.scope$/);
    expect(wrapped?.args).toEqual(
      runInAgentScopeArgs({
        args: ["bridge.js"],
        bindsTo: "bb-host-daemon.service",
        command: "/usr/bin/node",
        slice: "agents.slice",
        unit,
      }),
    );
    expect(wrapped?.env).toEqual({
      PATH: "/usr/bin",
      XDG_RUNTIME_DIR: "/run/user/1000",
    });
    expect(warnings).toEqual([]);
  });

  it("gives systemd-run the daemon's bus and the child its own values", async () => {
    const { deps } = fakeDeps({
      busEnv: () => ({
        DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
        XDG_RUNTIME_DIR: "/run/user/1000",
      }),
    });
    const placer = createAgentCgroupPlacer({ config: CONFIG, deps });
    await placer.prepare();

    const wrapped = placer.wrapSpawn({
      args: ["-c", "echo ${HOME}"],
      command: "/bin/sh",
      env: { PATH: "/usr/bin", XDG_RUNTIME_DIR: "/run/user/2000" },
      name: "",
      processKind: "terminal",
    });

    expect(wrapped?.env).toEqual({
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
      PATH: "/usr/bin",
      XDG_RUNTIME_DIR: "/run/user/1000",
    });
    const separator = wrapped?.args.indexOf("--") ?? -1;
    expect(wrapped?.args.slice(separator + 1)).toEqual([
      "/usr/bin/env",
      "-u",
      "DBUS_SESSION_BUS_ADDRESS",
      "--",
      "XDG_RUNTIME_DIR=/run/user/2000",
      "/bin/sh",
      "-c",
      "echo ${HOME}",
    ]);
  });

  it("leaves a spawn unwrapped when env cannot restore its values", async () => {
    const spawn = {
      args: [],
      command: "/opt/a=b/tool",
      env: { XDG_RUNTIME_DIR: "/run/user/2000" },
      name: "",
      processKind: "terminal",
    };
    const placer = createAgentCgroupPlacer({
      config: CONFIG,
      deps: fakeDeps().deps,
    });
    await placer.prepare();
    expect(placer.wrapSpawn(spawn)).toBe(null);
    expect(placer.wrapSpawn({ ...spawn, command: "/bin/sh" })).not.toBe(null);

    const noEnv = createAgentCgroupPlacer({
      config: CONFIG,
      deps: fakeDeps({
        resolveCommand: (name) => (name === "env" ? null : `/usr/bin/${name}`),
      }).deps,
    });
    await noEnv.prepare();
    expect(noEnv.wrapSpawn({ ...spawn, command: "/bin/sh" })).toBe(null);
    expect(
      noEnv.wrapSpawn({
        ...spawn,
        command: "/bin/sh",
        env: { XDG_RUNTIME_DIR: "/run/user/1000" },
      }),
    ).not.toBe(null);
  });

  it("stops wrapping when the user bus socket goes away", async () => {
    let reachable = true;
    const { calls, deps, warnings } = fakeDeps({
      busReachable: () => reachable,
    });
    const placer = createAgentCgroupPlacer({
      config: CONFIG,
      deps,
      owner: "the host daemon",
    });
    const spawn = {
      args: [],
      command: "/bin/sh",
      env: { XDG_RUNTIME_DIR: "/run/user/1000" },
      name: "",
      processKind: "terminal",
    };
    await placer.prepare();
    expect(placer.wrapSpawn(spawn)).not.toBe(null);

    reachable = false;
    expect(placer.wrapSpawn(spawn)).toBe(null);
    reachable = true;
    await placer.prepare();
    expect(placer.wrapSpawn(spawn)).toBe(null);
    expect(placer.wrapSpawn(spawn)).toBe(null);

    expect(calls.map((call) => call.command)).toEqual([
      "systemctl",
      "/usr/bin/systemd-run",
    ]);
    expect(warnings).toEqual([
      "Processes started by the host daemon now join agents.slice after they start, until it restarts: the systemd user bus socket is gone.",
    ]);
  });

  it("re-probes systemd-run at most once a minute and stops wrapping when it fails", async () => {
    let now = 0;
    let failProbe = false;
    const { calls, deps, warnings } = fakeDeps({
      now: () => now,
      run: async (command, args) => {
        calls.push({ command, args });
        if (failProbe && command.endsWith("systemd-run")) {
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
      command: "/bin/sh",
      env: { XDG_RUNTIME_DIR: "/run/user/1000" },
      name: "",
      processKind: "terminal",
    };
    await placer.prepare();

    now = 59_999;
    await placer.prepare();
    expect(placer.wrapSpawn(spawn)).not.toBe(null);
    expect(
      calls.filter((call) => call.command.endsWith("systemd-run")),
    ).toHaveLength(1);

    now = 60_000;
    await placer.prepare();
    expect(placer.wrapSpawn(spawn)).not.toBe(null);
    expect(
      calls.filter((call) => call.command.endsWith("systemd-run")),
    ).toHaveLength(2);

    failProbe = true;
    now = 120_000;
    expect(placer.wrapSpawn(spawn)).not.toBe(null);
    await placer.prepare();
    expect(placer.wrapSpawn(spawn)).toBe(null);
    now = 600_000;
    await placer.prepare();
    expect(placer.wrapSpawn(spawn)).toBe(null);

    expect(
      calls.filter((call) => call.command.endsWith("systemd-run")),
    ).toHaveLength(3);
    expect(warnings).toEqual([
      "Processes started by the host daemon now join agents.slice after they start, until it restarts: systemd-run failed (Connection timed out).",
    ]);
  });

  it("leaves spawns unwrapped when systemd-run fails its probe", async () => {
    const { calls, deps, warnings } = fakeDeps({
      run: async (command, args) => {
        calls.push({ command, args });
        if (command.endsWith("systemd-run")) {
          throw commandError(1, "Failed to connect to bus");
        }
      },
    });
    const placer = createAgentCgroupPlacer({
      config: CONFIG,
      deps,
      owner: "the host daemon",
    });

    await placer.prepare();
    await placer.prepare();
    const wrapped = placer.wrapSpawn({
      args: [],
      command: "/bin/sh",
      env: {},
      name: "",
      processKind: "terminal",
    });
    await placer.placeInScope({
      pid: 301,
      processKind: "terminal",
      unit: "bb-terminal-301.scope",
    });

    expect(wrapped).toBe(null);
    expect(calls.map((call) => call.command)).toEqual([
      "systemctl",
      "/usr/bin/systemd-run",
      "busctl",
    ]);
    expect(warnings).toEqual([
      "Processes started by the host daemon join agents.slice after they start: systemd-run failed (Failed to connect to bus).",
    ]);
  });

  it("leaves spawns unwrapped when systemd-run is missing", async () => {
    const { calls, deps, warnings } = fakeDeps({
      resolveCommand: () => null,
    });
    const placer = createAgentCgroupPlacer({ config: CONFIG, deps });

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
    expect(calls.map((call) => call.command)).toEqual(["systemctl"]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("systemd-run is not available");
  });

  it("stops wrapping once disposed", async () => {
    let releaseProbe: () => void = () => undefined;
    const { deps } = fakeDeps({
      run: async (command) => {
        if (command.endsWith("systemd-run")) {
          await new Promise<void>((resolve) => {
            releaseProbe = resolve;
          });
        }
      },
    });
    const spawn = {
      args: [],
      command: "/bin/sh",
      env: {},
      name: "",
      processKind: "terminal",
    };
    const pending = createAgentCgroupPlacer({ config: CONFIG, deps });
    const preparing = pending.prepare();
    await new Promise((resolve) => setImmediate(resolve));
    pending.dispose();
    releaseProbe();
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
