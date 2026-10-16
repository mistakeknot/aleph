import { execFile } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { delimiter, join } from "node:path";

export const AGENT_CGROUP_ENV = "BB_AGENT_CGROUP";
export const AGENT_CGROUP_SLICE_ENV = "BB_AGENT_CGROUP_SLICE";
export const AGENT_CPU_WEIGHT_ENV = "BB_AGENT_CPU_WEIGHT";
export const AGENT_CPU_QUOTA_ENV = "BB_AGENT_CPU_QUOTA";
export const AGENT_MEMORY_HIGH_ENV = "BB_AGENT_MEMORY_HIGH";

export const AGENT_CGROUP_ENV_NAMES = [
  AGENT_CGROUP_ENV,
  AGENT_CGROUP_SLICE_ENV,
  AGENT_CPU_WEIGHT_ENV,
  AGENT_CPU_QUOTA_ENV,
  AGENT_MEMORY_HIGH_ENV,
] as const;

export const DEFAULT_AGENT_SLICE = "agents.slice";
export const DEFAULT_AGENT_CPU_WEIGHT = 20;
const MAX_CPU_WEIGHT = 10_000;
const MAX_SCOPE_NAME_UNIT_CHARS = 64;
const MAX_CONSECUTIVE_PLACEMENT_FAILURES = 3;
const SYSTEMD_COMMAND_TIMEOUT_MS = 10_000;
const WRAPPER_REPROBE_INTERVAL_MS = 60_000;

const USER_BUS_ENV_NAMES = [
  "XDG_RUNTIME_DIR",
  "DBUS_SESSION_BUS_ADDRESS",
] as const;

const SLICE_NAME_PATTERN = /^[A-Za-z0-9_:]+(?:-[A-Za-z0-9_:]+)*\.slice$/;
const USER_MANAGER_SEGMENT_PATTERN = /^user@\d+\.service$/;
const MEMORY_BYTES_PATTERN = /^[1-9]\d*[KMGT]?$/;
const MEMORY_PERCENT_PATTERN = /^(?:[1-9]\d?|100)%$/;

export interface AgentCgroupConfig {
  slice: string;
  cpuWeight: number;
  cpuQuota: string | null;
  memoryHigh: string | null;
}

export function resolveAgentCgroupConfig(args: {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
}): AgentCgroupConfig | null {
  if (args.platform !== "linux") return null;
  if (args.env[AGENT_CGROUP_ENV]?.trim().toLowerCase() !== "systemd") {
    return null;
  }

  const rawSlice = args.env[AGENT_CGROUP_SLICE_ENV]?.trim() ?? "";
  const slice =
    rawSlice.length <= 255 && SLICE_NAME_PATTERN.test(rawSlice)
      ? rawSlice
      : DEFAULT_AGENT_SLICE;

  const rawWeight = args.env[AGENT_CPU_WEIGHT_ENV]?.trim() ?? "";
  const weight = /^\d+$/.test(rawWeight) ? Number(rawWeight) : Number.NaN;
  const cpuWeight =
    weight >= 1 && weight <= MAX_CPU_WEIGHT ? weight : DEFAULT_AGENT_CPU_WEIGHT;

  const rawQuota = args.env[AGENT_CPU_QUOTA_ENV]?.trim() ?? "";
  const cpuQuota =
    /^\d+%$/.test(rawQuota) && Number(rawQuota.slice(0, -1)) > 0
      ? rawQuota
      : null;

  const rawMemoryHigh = args.env[AGENT_MEMORY_HIGH_ENV]?.trim() ?? "";
  const memoryHigh =
    MEMORY_BYTES_PATTERN.test(rawMemoryHigh) ||
    MEMORY_PERCENT_PATTERN.test(rawMemoryHigh)
      ? rawMemoryHigh
      : null;

  return { slice, cpuWeight, cpuQuota, memoryHigh };
}

export function agentProcessScopeUnitName(args: {
  kind: string;
  name: string;
  pid: number | string;
}): string {
  const name = args.name
    .replace(/[^A-Za-z0-9_]/g, "_")
    .slice(0, MAX_SCOPE_NAME_UNIT_CHARS);
  return name === ""
    ? `bb-${args.kind}-${args.pid}.scope`
    : `bb-${args.kind}-${name}-${args.pid}.scope`;
}

export function agentScopeUnitName(args: {
  pid: number;
  threadId: string;
}): string {
  return agentProcessScopeUnitName({
    kind: "agent",
    name: args.threadId,
    pid: args.pid,
  });
}

export function ownSystemdUserUnit(procSelfCgroup: string): string | null {
  const line = procSelfCgroup
    .split("\n")
    .find((candidate) => candidate.startsWith("0::"));
  if (line === undefined) return null;
  const segments = line.slice(3).trim().split("/").filter(Boolean);
  const managerIndex = segments.findIndex((segment) =>
    USER_MANAGER_SEGMENT_PATTERN.test(segment),
  );
  if (managerIndex === -1 || managerIndex === segments.length - 1) return null;
  const leaf = segments[segments.length - 1]!;
  return leaf.endsWith(".service") || leaf.endsWith(".scope") ? leaf : null;
}

export function agentSlicePropertyArgs(config: AgentCgroupConfig): string[] {
  return [
    "--user",
    "set-property",
    "--runtime",
    config.slice,
    `CPUWeight=${config.cpuWeight}`,
    `CPUQuota=${config.cpuQuota ?? ""}`,
    `MemoryHigh=${config.memoryHigh ?? "infinity"}`,
  ];
}

export function startAgentScopeArgs(args: {
  bindsTo: string;
  pid: number;
  slice: string;
  unit: string;
}): string[] {
  return [
    "--user",
    "call",
    "org.freedesktop.systemd1",
    "/org/freedesktop/systemd1",
    "org.freedesktop.systemd1.Manager",
    "StartTransientUnit",
    "ssa(sv)a(sa(sv))",
    args.unit,
    "fail",
    "3",
    "PIDs",
    "au",
    "1",
    String(args.pid),
    "Slice",
    "s",
    args.slice,
    "BindsTo",
    "as",
    "1",
    args.bindsTo,
    "0",
  ];
}

export function runInAgentScopeArgs(args: {
  args: readonly string[];
  bindsTo: string;
  command: string;
  slice: string;
  unit: string;
}): string[] {
  return [
    "--user",
    "--scope",
    "--quiet",
    "--collect",
    "--expand-environment=no",
    `--unit=${args.unit}`,
    `--slice=${args.slice}`,
    "-p",
    `BindsTo=${args.bindsTo}`,
    "--",
    args.command,
    ...args.args,
  ];
}

export interface AgentCgroupDeps {
  busEnv(): Partial<Record<(typeof USER_BUS_ENV_NAMES)[number], string>>;
  busReachable(): boolean;
  isAlive(pid: number): boolean;
  now(): number;
  readOwnCgroup(): string | null;
  resolveCommand(name: string): string | null;
  run(command: string, args: string[]): Promise<void>;
  warn(message: string): void;
}

export interface AgentScopeSpawn {
  args: string[];
  command: string;
  env: NodeJS.ProcessEnv;
}

export interface AgentCgroupPlacer {
  dispose(): void;
  place(args: {
    pid: number | undefined;
    threadId: string | null;
  }): Promise<void>;
  placeInScope(args: {
    pid: number | undefined;
    processKind: string;
    unit: string;
  }): Promise<void>;
  prepare(): Promise<void>;
  wrapSpawn(args: {
    args: readonly string[];
    command: string;
    env: NodeJS.ProcessEnv;
    name: string;
    processKind: string;
  }): AgentScopeSpawn | null;
}

export function createAgentCgroupPlacer(args: {
  config: AgentCgroupConfig | null;
  deps: AgentCgroupDeps;
  owner?: string;
}): AgentCgroupPlacer {
  const { config, deps } = args;
  const owner = args.owner ?? "this provider process";
  let disabled = false;
  let disposed = false;
  let daemonUnit: Promise<string | null> | null = null;
  let prepared: Promise<void> | null = null;
  let wrapper: {
    bindsTo: string;
    envCommand: string | null;
    systemdRun: string;
  } | null = null;
  let lastProbeAt = 0;
  let reprobing: Promise<void> | null = null;
  let spawnSequence = 0;
  let consecutiveFailures = 0;
  const warnedClasses = new Set<string>();

  const warnOnce = (failureClass: string, message: string): void => {
    if (warnedClasses.has(failureClass)) return;
    warnedClasses.add(failureClass);
    deps.warn(message);
  };

  const disable = (reason: string): void => {
    if (disabled) return;
    disabled = true;
    warnOnce(
      "disabled",
      `Agent CPU isolation is off for ${owner}: ${reason}. Its child processes keep running in its own cgroup.`,
    );
  };

  const setUp = async (resolved: AgentCgroupConfig): Promise<string | null> => {
    const unit = ownSystemdUserUnit(deps.readOwnCgroup() ?? "");
    if (unit === null) {
      disable("it is not running under the systemd user manager");
      return null;
    }
    try {
      await deps.run("systemctl", agentSlicePropertyArgs(resolved));
    } catch (error) {
      disable(
        isMissingCommand(error)
          ? "systemctl is not available"
          : `could not configure ${resolved.slice} (${describeError(error)})`,
      );
      return null;
    }
    return unit;
  };

  const nextSpawnUnit = (kind: string, name: string): string => {
    spawnSequence += 1;
    return agentProcessScopeUnitName({
      kind,
      name,
      pid: `${process.pid}_${spawnSequence}`,
    });
  };

  const prepareWrapper = async (resolved: AgentCgroupConfig): Promise<void> => {
    daemonUnit ??= setUp(resolved);
    const bindsTo = await daemonUnit;
    if (bindsTo === null || disabled || disposed) return;
    const systemdRun = deps.resolveCommand("systemd-run");
    if (systemdRun === null) {
      warnOnce(
        "wrap",
        `Processes started by ${owner} join ${resolved.slice} after they start: systemd-run is not available.`,
      );
      return;
    }
    const failure = await probe(resolved, bindsTo, systemdRun);
    if (failure !== null) {
      warnOnce(
        "wrap",
        `Processes started by ${owner} join ${resolved.slice} after they start: systemd-run failed (${failure}).`,
      );
      return;
    }
    if (disabled || disposed) return;
    wrapper = { bindsTo, envCommand: deps.resolveCommand("env"), systemdRun };
  };

  const probe = async (
    resolved: AgentCgroupConfig,
    bindsTo: string,
    systemdRun: string,
  ): Promise<string | null> => {
    lastProbeAt = deps.now();
    try {
      await deps.run(
        systemdRun,
        runInAgentScopeArgs({
          args: [],
          bindsTo,
          command: "true",
          slice: resolved.slice,
          unit: nextSpawnUnit("probe", ""),
        }),
      );
      return null;
    } catch (error) {
      return describeError(error);
    }
  };

  const stopWrapping = (resolved: AgentCgroupConfig, reason: string): void => {
    if (wrapper === null) return;
    wrapper = null;
    warnOnce(
      "wrap-lost",
      `Processes started by ${owner} now join ${resolved.slice} after they start, until it restarts: ${reason}.`,
    );
  };

  const reprobeIfDue = (resolved: AgentCgroupConfig): Promise<void> => {
    if (reprobing !== null) return reprobing;
    const current = wrapper;
    if (
      current === null ||
      deps.now() - lastProbeAt < WRAPPER_REPROBE_INTERVAL_MS
    ) {
      return Promise.resolve();
    }
    reprobing = probe(resolved, current.bindsTo, current.systemdRun)
      .then((failure) => {
        if (failure !== null) {
          stopWrapping(resolved, `systemd-run failed (${failure})`);
        }
      })
      .finally(() => {
        reprobing = null;
      });
    return reprobing;
  };

  const placeInScope: AgentCgroupPlacer["placeInScope"] = async ({
    pid,
    processKind,
    unit,
  }) => {
    if (config === null || disabled || disposed || pid === undefined) return;
    daemonUnit ??= setUp(config);
    const bindsTo = await daemonUnit;
    if (bindsTo === null || disabled || disposed) return;

    try {
      await deps.run(
        "busctl",
        startAgentScopeArgs({
          bindsTo,
          pid,
          slice: config.slice,
          unit,
        }),
      );
      consecutiveFailures = 0;
    } catch (error) {
      if (isMissingCommand(error)) {
        disable("busctl is not available");
        return;
      }
      if (disposed || !deps.isAlive(pid)) return;
      consecutiveFailures += 1;
      warnOnce(
        "placement",
        `Could not move ${processKind} ${pid} into ${config.slice} (${describeError(error)}). Later placement failures are not logged; after ${MAX_CONSECUTIVE_PLACEMENT_FAILURES} in a row, isolation turns off.`,
      );
      if (consecutiveFailures >= MAX_CONSECUTIVE_PLACEMENT_FAILURES) {
        warnedClasses.add("disabled");
        disable(`${consecutiveFailures} placements in a row failed`);
      }
    }
  };

  return {
    dispose() {
      disposed = true;
      wrapper = null;
    },
    placeInScope,
    async place({ pid, threadId }) {
      if (pid === undefined || threadId === null) return;
      await placeInScope({
        pid,
        processKind: "agent process",
        unit: agentScopeUnitName({ pid, threadId }),
      });
    },
    prepare() {
      if (config === null || disposed) return Promise.resolve();
      prepared ??= prepareWrapper(config);
      return prepared.then(() => reprobeIfDue(config));
    },
    wrapSpawn(spawn) {
      if (config === null || wrapper === null || disabled || disposed) {
        return null;
      }
      if (!deps.busReachable()) {
        stopWrapping(config, "the systemd user bus socket is gone");
        return null;
      }
      void reprobeIfDue(config);

      const env = { ...spawn.env };
      const busEnv = deps.busEnv();
      const unset: string[] = [];
      const restore: string[] = [];
      for (const name of USER_BUS_ENV_NAMES) {
        const own = spawn.env[name];
        const daemon = busEnv[name];
        if (own === daemon) continue;
        if (daemon === undefined) delete env[name];
        else env[name] = daemon;
        if (own === undefined) unset.push("-u", name);
        else restore.push(`${name}=${own}`);
      }
      let command = spawn.command;
      let args = spawn.args;
      if (unset.length > 0 || restore.length > 0) {
        if (wrapper.envCommand === null || spawn.command.includes("=")) {
          return null;
        }
        command = wrapper.envCommand;
        args = [...unset, "--", ...restore, spawn.command, ...spawn.args];
      }
      return {
        args: runInAgentScopeArgs({
          args,
          bindsTo: wrapper.bindsTo,
          command,
          slice: config.slice,
          unit: nextSpawnUnit(spawn.processKind, spawn.name),
        }),
        command: wrapper.systemdRun,
        env,
      };
    },
  };
}

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error
    ? error.code
    : undefined;
}

function isMissingCommand(error: unknown): boolean {
  return errorCode(error) === "ENOENT";
}

function describeError(error: unknown): string {
  if (typeof error === "object" && error !== null && "stderr" in error) {
    const stderr = String(error.stderr).trim();
    if (stderr !== "") return stderr;
  }
  return error instanceof Error ? error.message : String(error);
}

export const defaultAgentCgroupDeps: AgentCgroupDeps = {
  busEnv() {
    const env: ReturnType<AgentCgroupDeps["busEnv"]> = {};
    for (const name of USER_BUS_ENV_NAMES) {
      const value = process.env[name];
      if (value !== undefined) env[name] = value;
    }
    return env;
  },
  busReachable() {
    const address = process.env.DBUS_SESSION_BUS_ADDRESS;
    if (address !== undefined && address !== "") {
      const path = /(?:^|;)unix:(?:[^;]*,)?path=([^,;]+)/.exec(address)?.[1];
      return path === undefined || existsSync(decodeBusPath(path));
    }
    const runtimeDir = process.env.XDG_RUNTIME_DIR;
    return runtimeDir !== undefined && existsSync(join(runtimeDir, "bus"));
  },
  isAlive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return errorCode(error) !== "ESRCH";
    }
  },
  readOwnCgroup() {
    try {
      return readFileSync("/proc/self/cgroup", "utf8");
    } catch {
      return null;
    }
  },
  resolveCommand(name) {
    for (const dir of (process.env.PATH ?? "").split(delimiter)) {
      if (dir === "") continue;
      const candidate = join(dir, name);
      try {
        accessSync(candidate, constants.X_OK);
      } catch {
        continue;
      }
      return candidate;
    }
    return null;
  },
  run(command, args) {
    return new Promise((resolve, reject) => {
      execFile(
        command,
        args,
        { timeout: SYSTEMD_COMMAND_TIMEOUT_MS, windowsHide: true },
        (error, _stdout, stderr) => {
          if (error === null) {
            resolve();
            return;
          }
          reject(Object.assign(error, { stderr }));
        },
      );
    });
  },
  now() {
    return Date.now();
  },
  warn(message) {
    process.stderr.write(`${message}\n`);
  },
};

function decodeBusPath(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

let defaultPlacer: AgentCgroupPlacer | null = null;

export function experimental_isAgentCgroupIsolationRequested(): boolean {
  return (
    resolveAgentCgroupConfig({
      env: process.env,
      platform: process.platform,
    }) !== null
  );
}

export function experimental_placeProviderChildInThreadScope(
  child: { pid?: number | undefined },
  scope: { threadId: string | null },
): void {
  defaultPlacer ??= createAgentCgroupPlacer({
    config: resolveAgentCgroupConfig({
      env: process.env,
      platform: process.platform,
    }),
    deps: defaultAgentCgroupDeps,
  });
  void defaultPlacer
    .place({ pid: child.pid, threadId: scope.threadId })
    .catch(() => undefined);
}
