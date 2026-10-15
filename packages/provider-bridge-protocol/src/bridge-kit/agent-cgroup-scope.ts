import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";

export const AGENT_CGROUP_ENV = "BB_AGENT_CGROUP";
export const AGENT_CGROUP_SLICE_ENV = "BB_AGENT_CGROUP_SLICE";
export const AGENT_CPU_WEIGHT_ENV = "BB_AGENT_CPU_WEIGHT";
export const AGENT_CPU_QUOTA_ENV = "BB_AGENT_CPU_QUOTA";

export const AGENT_CGROUP_ENV_NAMES = [
  AGENT_CGROUP_ENV,
  AGENT_CGROUP_SLICE_ENV,
  AGENT_CPU_WEIGHT_ENV,
  AGENT_CPU_QUOTA_ENV,
] as const;

export const DEFAULT_AGENT_SLICE = "bb_agents.slice";
export const DEFAULT_AGENT_CPU_WEIGHT = 20;
const MAX_CPU_WEIGHT = 10_000;
const MAX_THREAD_ID_UNIT_CHARS = 64;
const MAX_CONSECUTIVE_PLACEMENT_FAILURES = 3;
const SYSTEMD_COMMAND_TIMEOUT_MS = 10_000;

const SLICE_NAME_PATTERN = /^[A-Za-z0-9_:]+(?:-[A-Za-z0-9_:]+)*\.slice$/;
const USER_MANAGER_SEGMENT_PATTERN = /^user@\d+\.service$/;

export interface AgentCgroupConfig {
  slice: string;
  cpuWeight: number;
  cpuQuota: string | null;
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

  return { slice, cpuWeight, cpuQuota };
}

export function agentScopeUnitName(args: {
  pid: number;
  threadId: string;
}): string {
  const thread = args.threadId
    .replace(/[^A-Za-z0-9_]/g, "_")
    .slice(0, MAX_THREAD_ID_UNIT_CHARS);
  return `bb-agent-${thread}-${args.pid}.scope`;
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

export interface AgentCgroupDeps {
  isAlive(pid: number): boolean;
  readOwnCgroup(): string | null;
  run(command: string, args: string[]): Promise<void>;
  warn(message: string): void;
}

export interface AgentCgroupPlacer {
  place(args: {
    pid: number | undefined;
    threadId: string | null;
  }): Promise<void>;
}

export function createAgentCgroupPlacer(args: {
  config: AgentCgroupConfig | null;
  deps: AgentCgroupDeps;
}): AgentCgroupPlacer {
  const { config, deps } = args;
  let disabled = false;
  let daemonUnit: Promise<string | null> | null = null;
  let consecutiveFailures = 0;

  const disable = (reason: string): void => {
    if (disabled) return;
    disabled = true;
    deps.warn(
      `Agent CPU isolation is off for this provider process: ${reason}. Agents keep running in the host daemon's cgroup.`,
    );
  };

  const setUp = async (resolved: AgentCgroupConfig): Promise<string | null> => {
    const unit = ownSystemdUserUnit(deps.readOwnCgroup() ?? "");
    if (unit === null) {
      disable(
        "the provider process is not running under the systemd user manager",
      );
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

  return {
    async place({ pid, threadId }) {
      if (config === null || disabled) return;
      if (pid === undefined || threadId === null) return;
      daemonUnit ??= setUp(config);
      const bindsTo = await daemonUnit;
      if (bindsTo === null || disabled) return;

      try {
        await deps.run(
          "busctl",
          startAgentScopeArgs({
            bindsTo,
            pid,
            slice: config.slice,
            unit: agentScopeUnitName({ pid, threadId }),
          }),
        );
        consecutiveFailures = 0;
      } catch (error) {
        if (isMissingCommand(error)) {
          disable("busctl is not available");
          return;
        }
        if (!deps.isAlive(pid)) return;
        consecutiveFailures += 1;
        deps.warn(
          `Could not move agent process ${pid} into ${config.slice} (${describeError(error)}).`,
        );
        if (consecutiveFailures >= MAX_CONSECUTIVE_PLACEMENT_FAILURES) {
          disable(`${consecutiveFailures} placements in a row failed`);
        }
      }
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

const defaultDeps: AgentCgroupDeps = {
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
  warn(message) {
    process.stderr.write(`${message}\n`);
  },
};

let defaultPlacer: AgentCgroupPlacer | null = null;

export function experimental_placeProviderChildInThreadScope(
  child: { pid?: number | undefined },
  scope: { threadId: string | null },
): void {
  defaultPlacer ??= createAgentCgroupPlacer({
    config: resolveAgentCgroupConfig({
      env: process.env,
      platform: process.platform,
    }),
    deps: defaultDeps,
  });
  void defaultPlacer
    .place({ pid: child.pid, threadId: scope.threadId })
    .catch(() => undefined);
}
