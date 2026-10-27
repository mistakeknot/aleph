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

export function readActiveMigration(
  databasePath: string,
): MigrationHolderInfo | null {
  const info = readHolderInfo(databasePath);
  if (info === null) return null;
  return isProcessAlive(info.pid) ? info : null;
}
