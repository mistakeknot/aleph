import { existsSync, readFileSync } from "node:fs";

export const MIGRATION_WAIT_CAP_MS = 60 * 60 * 1000;

export type MigrationPhase =
  | "waiting"
  | "classifying"
  | "backup"
  | "migrating"
  | "verifying"
  | "finalizing";

export interface MigrationHolderInfo {
  pid: number;
  token: string;
  databaseBytes: number;
  expectedMs: number;
  phase: MigrationPhase;
  updatedAt: number;
  processStart?: string | null;
}

export function migratingLockPath(databasePath: string): string {
  return `${databasePath}.migrating.lock`;
}

export function migratingInfoPath(databasePath: string): string {
  return `${databasePath}.migrating.info`;
}

export function readHolderInfo(
  databasePath: string,
): MigrationHolderInfo | null {
  const path = migratingInfoPath(databasePath);
  if (!existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "pid" in parsed &&
      typeof parsed.pid === "number" &&
      "token" in parsed &&
      typeof parsed.token === "string" &&
      "databaseBytes" in parsed &&
      typeof parsed.databaseBytes === "number" &&
      "expectedMs" in parsed &&
      typeof parsed.expectedMs === "number" &&
      "phase" in parsed &&
      typeof parsed.phase === "string" &&
      "updatedAt" in parsed &&
      typeof parsed.updatedAt === "number"
    ) {
      return {
        pid: parsed.pid,
        token: parsed.token,
        databaseBytes: parsed.databaseBytes,
        expectedMs: parsed.expectedMs,
        phase: parsed.phase as MigrationPhase,
        updatedAt: parsed.updatedAt,
        processStart:
          "processStart" in parsed && typeof parsed.processStart === "string"
            ? parsed.processStart
            : null,
      };
    }
  } catch {
    return null;
  }
  return null;
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "EPERM"
    );
  }
}

export function processIdentity(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const afterName = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const startTicks = afterName[19];
    if (startTicks === undefined || startTicks === "") return null;
    let bootId = "";
    try {
      bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    } catch {}
    return `${bootId}:${startTicks}`;
  } catch {
    return null;
  }
}

export interface ReadActiveMigrationOptions {
  now?: () => number;
  identityOf?: (pid: number) => string | null;
  isAlive?: (pid: number) => boolean;
  capMs?: number;
}

export function readActiveMigration(
  databasePath: string,
  options: ReadActiveMigrationOptions = {},
): MigrationHolderInfo | null {
  const info = readHolderInfo(databasePath);
  if (info === null) return null;
  if (!(options.isAlive ?? isProcessAlive)(info.pid)) return null;
  const now = (options.now ?? Date.now)();
  if (now - info.updatedAt > (options.capMs ?? MIGRATION_WAIT_CAP_MS)) {
    return null;
  }
  if (typeof info.processStart === "string") {
    const current = (options.identityOf ?? processIdentity)(info.pid);
    if (current !== null && current !== info.processStart) return null;
  }
  return info;
}
