import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";

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

export function startupMarkerPath(
  databasePath: string,
  pid: number = process.pid,
): string {
  return `${databasePath}.starting.${pid}.info`;
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

function isLiveOwner(
  info: { pid: number; updatedAt: number; processStart?: string | null },
  options: ReadActiveMigrationOptions,
): boolean {
  if (!(options.isAlive ?? isProcessAlive)(info.pid)) return false;
  const now = (options.now ?? Date.now)();
  if (now - info.updatedAt > (options.capMs ?? MIGRATION_WAIT_CAP_MS)) {
    return false;
  }
  if (typeof info.processStart === "string") {
    const current = (options.identityOf ?? processIdentity)(info.pid);
    if (current !== null && current !== info.processStart) return false;
  }
  return true;
}

export function readActiveMigration(
  databasePath: string,
  options: ReadActiveMigrationOptions = {},
): MigrationHolderInfo | null {
  const info = readHolderInfo(databasePath);
  if (info === null) return null;
  return isLiveOwner(info, options) ? info : null;
}

export interface DatabaseStartupMarker {
  pid: number;
  updatedAt: number;
  processStart?: string | null;
}

export function writeStartupMarker(databasePath: string): void {
  const marker: DatabaseStartupMarker = {
    pid: process.pid,
    updatedAt: Date.now(),
    processStart: processIdentity(process.pid),
  };
  try {
    writeFileSync(startupMarkerPath(databasePath), JSON.stringify(marker), {
      mode: 0o600,
    });
  } catch {}
}

export function removeStartupMarker(databasePath: string): void {
  try {
    unlinkSync(startupMarkerPath(databasePath));
  } catch {}
}

function readStartupMarker(
  databasePath: string,
  pid: number,
): DatabaseStartupMarker | null {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(startupMarkerPath(databasePath, pid), "utf8"),
    );
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "pid" in parsed &&
      parsed.pid === pid &&
      "updatedAt" in parsed &&
      typeof parsed.updatedAt === "number"
    ) {
      return {
        pid,
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

export function readActiveStartup(
  databasePath: string,
  pid: number,
  options: ReadActiveMigrationOptions = {},
): DatabaseStartupMarker | null {
  const marker = readStartupMarker(databasePath, pid);
  if (marker === null) return null;
  return isLiveOwner(marker, options) ? marker : null;
}
