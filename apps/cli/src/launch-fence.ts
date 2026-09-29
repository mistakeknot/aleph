import { homedir } from "node:os";
import {
  exitCodeForLaunchFailure,
  runLaunchGuard,
} from "@bb/config/launch-guard";
import { resolveCliErrorLogLocation } from "./cli-error-log.js";
import { resolveBbCliVersion } from "./version.js";

export interface CliLaunchGuardArgs {
  env: NodeJS.ProcessEnv;
  homeDir: string;
  version: string;
}

export function evaluateCliLaunchGuard(
  args: CliLaunchGuardArgs,
): { exitCode: number; message: string } | null {
  try {
    runLaunchGuard({
      dataDir: resolveCliErrorLogLocation(args.env).dataDir,
      homeDir: args.homeDir,
      role: "cli",
      version: args.version,
    });
    return null;
  } catch (error) {
    return {
      exitCode: exitCodeForLaunchFailure(error),
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export function guardCliLaunch(): void {
  const refusal = evaluateCliLaunchGuard({
    env: process.env,
    homeDir: homedir(),
    version: resolveBbCliVersion(),
  });
  if (refusal === null) return;
  process.stderr.write(`${refusal.message}\n`);
  process.exit(refusal.exitCode);
}
