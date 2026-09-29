import { homedir } from "node:os";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  evaluateLaunchGuard,
  exitOnLaunchRefusal,
  type LaunchRefusal,
} from "@bb/config/launch-guard";
import { resolveCliErrorLogLocation } from "./cli-error-log.js";

export interface CliLaunchGuardArgs {
  env: NodeJS.ProcessEnv;
  fromDir: string;
  homeDir: string;
}

export function evaluateCliLaunchGuard(
  args: CliLaunchGuardArgs,
): LaunchRefusal | null {
  return evaluateLaunchGuard({
    dataDir: resolveCliErrorLogLocation(args.env).dataDir,
    env: args.env,
    fromDir: args.fromDir,
    homeDir: args.homeDir,
    role: "cli",
  });
}

export function guardCliLaunch(): void {
  exitOnLaunchRefusal({
    dataDir: resolveCliErrorLogLocation(process.env).dataDir,
    env: process.env,
    fromDir: dirname(fileURLToPath(import.meta.url)),
    homeDir: homedir(),
    role: "cli",
  });
}
