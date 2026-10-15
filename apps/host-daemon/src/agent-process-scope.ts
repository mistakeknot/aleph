import {
  agentProcessScopeUnitName,
  createAgentCgroupPlacer,
  defaultAgentCgroupDeps,
  resolveAgentCgroupConfig,
  type AgentCgroupPlacer,
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
      unit: agentProcessScopeUnitName({
        kind: args.processKind,
        name: args.name,
        pid: args.pid,
      }),
    })
    .catch(() => undefined);
}
