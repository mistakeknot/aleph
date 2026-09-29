import { assertAlephDataDir } from "./aleph-data-dir.js";
import { DEFAULTS } from "./defaults.js";
import {
  enforceMaintenanceFence,
  type FenceProcessRole,
  type MaintenanceFenceDecision,
} from "./maintenance-fence.js";

export interface LaunchGuardArgs {
  dataDir: string;
  homeDir: string;
  role: FenceProcessRole;
  version: string;
}

export function runLaunchGuard(
  args: LaunchGuardArgs,
): MaintenanceFenceDecision {
  assertAlephDataDir({ dataDir: args.dataDir, homeDir: args.homeDir });
  return enforceMaintenanceFence({
    dataDir: args.dataDir,
    identity: { role: args.role, version: args.version },
  });
}

export function exitCodeForLaunchFailure(error: unknown): number {
  const code =
    typeof error === "object" && error !== null
      ? Reflect.get(error, "exitCode")
      : undefined;
  return typeof code === "number" ? code : 1;
}

export function resolveLaunchVersion(env: NodeJS.ProcessEnv): string {
  const configured = env.BB_APP_VERSION?.trim();
  return configured === undefined || configured.length === 0
    ? DEFAULTS.appVersion
    : configured;
}
