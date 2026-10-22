import { randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import Database from "better-sqlite3";

export const MIGRATION_WAIT_CAP_MS = 60 * 60 * 1000;

const POLL_BUSY_TIMEOUT_MS = 250;
const IN_USE_BUSY_TIMEOUT_MS = 5000;

export type MigrationPhase =
  | "waiting"
  | "classifying"
  | "backup"
  | "migrating"
  | "verifying";

export interface MigrationHolderInfo {
  pid: number;
  token: string;
  databaseBytes: number;
  expectedMs: number;
  phase: MigrationPhase;
  updatedAt: number;
}

export class MigrationLockTimeout extends Error {
  readonly holder: MigrationHolderInfo | null;

  constructor(message: string, holder: MigrationHolderInfo | null) {
    super(message);
    this.name = "MigrationLockTimeout";
    this.holder = holder;
  }
}

const heldHandles = new Set<Database.Database>();

export function heldMigrationLockHandleCount(): number {
  return heldHandles.size;
}

export function inUseLockPath(databasePath: string): string {
  return `${databasePath}.in-use.lock`;
}

export function migratingLockPath(databasePath: string): string {
  return `${databasePath}.migrating.lock`;
}

export function migratingInfoPath(databasePath: string): string {
  return `${databasePath}.migrating.info`;
}

export function isLockableDatabase(sqlite: Database.Database): boolean {
  return !sqlite.memory && sqlite.name !== "" && sqlite.name !== ":memory:";
}

function openLockDatabase(path: string, busyTimeoutMs: number) {
  const lock = new Database(path);
  lock.pragma(`busy_timeout = ${busyTimeoutMs}`);
  return lock;
}

function isBusy(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "SQLITE_BUSY" || error.code === "SQLITE_LOCKED")
  );
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
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

function writeFileDurably(path: string, content: string): void {
  const temporary = `${path}.${process.pid}.tmp`;
  const handle = openSync(temporary, "w", 0o600);
  try {
    writeFileSync(handle, content);
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
  renameSync(temporary, path);
}

export function acquireInUseLock(sqlite: Database.Database): void {
  if (!isLockableDatabase(sqlite)) return;
  const lock = openLockDatabase(
    inUseLockPath(sqlite.name),
    IN_USE_BUSY_TIMEOUT_MS,
  );
  try {
    lock.exec("BEGIN");
    lock.prepare("SELECT count(*) FROM sqlite_master").get();
  } catch (error) {
    lock.close();
    throw error;
  }
  heldHandles.add(lock);
  const originalClose = sqlite.close.bind(sqlite);
  sqlite.close = () => {
    try {
      return originalClose();
    } finally {
      if (heldHandles.delete(lock)) lock.close();
    }
  };
}

export interface MigratingLock {
  setPhase(phase: MigrationPhase): void;
  release(): void;
}

export function acquireMigratingLock(
  sqlite: Database.Database,
  options: { waitCapMs?: number; expectedMs?: number } = {},
): MigratingLock | null {
  if (!isLockableDatabase(sqlite)) return null;
  const databasePath = sqlite.name;
  const capMs = options.waitCapMs ?? MIGRATION_WAIT_CAP_MS;
  const lock = openLockDatabase(
    migratingLockPath(databasePath),
    POLL_BUSY_TIMEOUT_MS,
  );
  const startedAt = Date.now();
  for (;;) {
    try {
      lock.exec("BEGIN EXCLUSIVE");
      break;
    } catch (error) {
      if (!isBusy(error)) {
        lock.close();
        throw error;
      }
      const holder = readHolderInfo(databasePath);
      if (Date.now() - startedAt >= capMs) {
        lock.close();
        throw new MigrationLockTimeout(
          holder === null
            ? `Another process holds the migration lock for ${databasePath}; waited ${capMs} ms`
            : `Process ${holder.pid} has held the migration lock for ${databasePath} for over ${capMs} ms (phase ${holder.phase}, expected ${holder.expectedMs} ms)`,
          holder,
        );
      }
    }
  }
  heldHandles.add(lock);
  const releaseHandle = (): void => {
    try {
      if (lock.inTransaction) lock.exec("ROLLBACK");
    } finally {
      heldHandles.delete(lock);
      lock.close();
    }
  };
  try {
    const token = randomBytes(8).toString("hex");
    const databaseBytes = existsSync(databasePath)
      ? statSync(databasePath).size
      : 0;
    const expectedMs = options.expectedMs ?? databaseBytes / 50_000;
    const writeInfo = (phase: MigrationPhase): void => {
      writeFileDurably(
        migratingInfoPath(databasePath),
        JSON.stringify({
          pid: process.pid,
          token,
          databaseBytes,
          expectedMs,
          phase,
          updatedAt: Date.now(),
        } satisfies MigrationHolderInfo),
      );
    };
    writeInfo("classifying");
    let released = false;
    return {
      setPhase: writeInfo,
      release: () => {
        if (released) return;
        released = true;
        releaseHandle();
      },
    };
  } catch (error) {
    releaseHandle();
    throw error;
  }
}

export function waitWhileMigrating(
  sqlite: Database.Database,
  waitCapMs: number = MIGRATION_WAIT_CAP_MS,
): void {
  if (!isLockableDatabase(sqlite)) return;
  const path = migratingLockPath(sqlite.name);
  if (!existsSync(path)) return;
  const probe = openLockDatabase(path, POLL_BUSY_TIMEOUT_MS);
  const startedAt = Date.now();
  try {
    for (;;) {
      try {
        probe.exec("BEGIN");
        probe.prepare("SELECT count(*) FROM sqlite_master").get();
        probe.exec("ROLLBACK");
        return;
      } catch (error) {
        if (probe.inTransaction) probe.exec("ROLLBACK");
        if (!isBusy(error)) throw error;
        if (Date.now() - startedAt >= waitCapMs) {
          const holder = readHolderInfo(sqlite.name);
          throw new MigrationLockTimeout(
            holder === null
              ? `A migration is running on ${sqlite.name}; waited ${waitCapMs} ms`
              : `Process ${holder.pid} is migrating ${sqlite.name} (phase ${holder.phase}); waited ${waitCapMs} ms`,
            holder,
          );
        }
        sleep(50);
      }
    }
  } finally {
    probe.close();
  }
}
