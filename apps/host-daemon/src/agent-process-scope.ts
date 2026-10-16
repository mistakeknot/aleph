import {
  agentProcessScopeUnitName,
  createAgentCgroupPlacer,
  defaultAgentCgroupDeps,
  resolveAgentCgroupConfig,
  type AgentCgroupPlacer,
  type AgentScopeSpawn,
} from "@bb/provider-bridge-protocol/bridge-kit";
import type { HostDaemonLogger } from "./logger.js";

export type AgentProcessScopeKind =
  | "plugin-worker"
  | "provider-worker"
  | "terminal";

interface PlaceAgentProcessInScopeArgs {
  logger: Pick<HostDaemonLogger, "warn"> | undefined;
  name: string;
  pid: number | undefined;
  placer?: AgentCgroupPlacer;
  processKind: AgentProcessScopeKind;
  scopeUnit?: string | null;
}

let defaultPlacer: AgentCgroupPlacer | null = null;

function getDefaultPlacer(
  logger: Pick<HostDaemonLogger, "warn"> | undefined,
): AgentCgroupPlacer {
  defaultPlacer ??= createAgentCgroupPlacer({
    config: resolveAgentCgroupConfig({
      env: process.env,
      platform: process.platform,
    }),
    deps: {
      ...defaultAgentCgroupDeps,
      warn: (message) => {
        if (logger === undefined) {
          defaultAgentCgroupDeps.warn(message);
          return;
        }
        logger.warn({}, message);
      },
    },
    owner: "the host daemon",
  });
  return defaultPlacer;
}

export function placeAgentProcessInScope(
  args: PlaceAgentProcessInScopeArgs,
): void {
  if (args.pid === undefined) return;
  const placer = args.placer ?? getDefaultPlacer(args.logger);
  void placer
    .placeInScope({
      pid: args.pid,
      processKind: args.processKind,
      unit:
        args.scopeUnit ??
        agentProcessScopeUnitName({
          kind: args.processKind,
          name: args.name,
          pid: args.pid,
        }),
    })
    .catch(() => undefined);
}

export function prepareAgentProcessScopes(args: {
  logger: Pick<HostDaemonLogger, "warn"> | undefined;
  placer?: AgentCgroupPlacer;
}): Promise<void> {
  const placer = args.placer ?? getDefaultPlacer(args.logger);
  return placer.prepare().catch(() => undefined);
}

export function wrapAgentProcessSpawn(args: {
  args: readonly string[];
  command: string;
  env: NodeJS.ProcessEnv;
  logger: Pick<HostDaemonLogger, "warn"> | undefined;
  name: string;
  placer?: AgentCgroupPlacer;
  processKind: AgentProcessScopeKind;
}): AgentScopeSpawn | null {
  const placer = args.placer ?? getDefaultPlacer(args.logger);
  return placer.wrapSpawn({
    args: args.args,
    command: args.command,
    env: args.env,
    name: args.name,
    processKind: args.processKind,
  });
}

export function disposeAgentProcessScopes(): void {
  defaultPlacer?.dispose();
}
