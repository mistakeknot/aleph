import { readdirSync } from "node:fs";
import os from "node:os";
import type { HostDaemonLogger } from "./logger.js";

export const DEFAULT_AGENT_NICE = 10;
const MAX_NICE = 19;

interface ResolveAgentNiceArgs {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
}

export function resolveAgentNice(args: ResolveAgentNiceArgs): number | null {
  if (args.platform === "win32") {
    return null;
  }
  const raw = args.env.BB_AGENT_NICE?.trim();
  if (raw === undefined || raw === "" || !/^\d+$/.test(raw)) {
    return DEFAULT_AGENT_NICE;
  }
  const nice = Math.min(Number(raw), MAX_NICE);
  return nice === 0 ? null : nice;
}

export interface AgentProcessPriorityDeps {
  getPriority: (pid: number) => number;
  listThreadIds: (pid: number) => number[];
  setPriority: (pid: number, priority: number) => void;
}

function listLinuxThreadIds(pid: number): number[] {
  return readdirSync(`/proc/${pid}/task`)
    .map(Number)
    .filter((tid) => Number.isInteger(tid) && tid !== pid);
}

const defaultDeps: AgentProcessPriorityDeps = {
  getPriority: (pid) => os.getPriority(pid),
  listThreadIds: (pid) =>
    process.platform === "linux" ? listLinuxThreadIds(pid) : [],
  setPriority: (pid, priority) => os.setPriority(pid, priority),
};

interface LowerAgentProcessPriorityArgs {
  deps?: AgentProcessPriorityDeps;
  env?: NodeJS.ProcessEnv;
  logger: Pick<HostDaemonLogger, "warn">;
  pid: number | undefined;
  platform?: NodeJS.Platform;
  processKind: string;
}

export function lowerAgentProcessPriority(
  args: LowerAgentProcessPriorityArgs,
): void {
  const nice = resolveAgentNice({
    env: args.env ?? process.env,
    platform: args.platform ?? process.platform,
  });
  if (nice === null || args.pid === undefined) {
    return;
  }
  const deps = args.deps ?? defaultDeps;
  const raise = (tid: number): void => {
    if (deps.getPriority(tid) < nice) {
      deps.setPriority(tid, nice);
    }
  };
  try {
    raise(args.pid);
    for (const tid of deps.listThreadIds(args.pid)) {
      try {
        raise(tid);
      } catch {
        continue;
      }
    }
  } catch (error) {
    if (isExitedProcessError(error)) return;
    args.logger.warn(
      { pid: args.pid, processKind: args.processKind, nice, err: error },
      "Failed to lower agent process priority",
    );
  }
}

function isExitedProcessError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = "code" in error ? error.code : undefined;
  if (code === "ESRCH" || code === "ENOENT") return true;
  const info = "info" in error ? error.info : undefined;
  return (
    typeof info === "object" &&
    info !== null &&
    "code" in info &&
    info.code === "ESRCH"
  );
}
