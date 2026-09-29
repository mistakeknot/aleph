import { readFileSync, writeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { alephReleaseIdentity } from "./aleph-version.js";
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

const PACKAGE_LOOKUP_MAX_DEPTH = 8;
const RELEASE_PACKAGE_NAME = "bb-app";

export class LaunchVersionMismatchError extends Error {
  readonly exitCode = 1;

  constructor(codeVersion: string, envVersion: string) {
    super(
      `BB_APP_VERSION ${envVersion} does not match the running code ${codeVersion}`,
    );
    this.name = "LaunchVersionMismatchError";
  }
}

function readReleasePackageVersion(packageJsonPath: string): string | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    const name: unknown = Reflect.get(parsed, "name");
    const version: unknown = Reflect.get(parsed, "version");
    return name === RELEASE_PACKAGE_NAME &&
      typeof version === "string" &&
      version.length > 0
      ? version
      : null;
  } catch {
    return null;
  }
}

export function resolveCodeVersion(fromDir: string): string {
  let current = resolve(fromDir);
  for (let depth = 0; depth < PACKAGE_LOOKUP_MAX_DEPTH; depth += 1) {
    const found =
      readReleasePackageVersion(join(current, "package.json")) ??
      readReleasePackageVersion(
        join(current, "packages", RELEASE_PACKAGE_NAME, "package.json"),
      );
    if (found !== null) return found;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return DEFAULTS.appVersion;
}

export function resolveLaunchVersion(
  env: NodeJS.ProcessEnv,
  fromDir: string,
): string {
  const codeVersion = resolveCodeVersion(fromDir);
  const envVersion = env.BB_APP_VERSION?.trim();
  if (
    envVersion !== undefined &&
    envVersion.length > 0 &&
    alephReleaseIdentity(envVersion) !== alephReleaseIdentity(codeVersion) &&
    codeVersion !== DEFAULTS.appVersion
  ) {
    throw new LaunchVersionMismatchError(codeVersion, envVersion);
  }
  return codeVersion;
}

export interface LaunchRefusal {
  exitCode: number;
  message: string;
}

export function evaluateLaunchGuard(
  args: Omit<LaunchGuardArgs, "version"> & {
    env: NodeJS.ProcessEnv;
    fromDir: string;
  },
): LaunchRefusal | null {
  try {
    runLaunchGuard({
      dataDir: args.dataDir,
      homeDir: args.homeDir,
      role: args.role,
      version: resolveLaunchVersion(args.env, args.fromDir),
    });
    return null;
  } catch (error) {
    return {
      exitCode: exitCodeForLaunchFailure(error),
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export function exitOnLaunchRefusal(
  args: Parameters<typeof evaluateLaunchGuard>[0],
): void {
  const refusal = evaluateLaunchGuard(args);
  if (refusal === null) return;
  writeSync(2, `${refusal.message}\n`);
  process.exit(refusal.exitCode);
}
