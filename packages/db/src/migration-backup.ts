import { createHash, randomBytes } from "node:crypto";
import {
  accessSync,
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  statfsSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import Database from "better-sqlite3";

export const CONTENT_PROJECTION = "content-v2";
export const SEQUENCE_PROJECTION = "sequence-v1";
export const BACKUP_MARKER = ".pre-ns-";
export const SIDECAR_SUFFIX = ".sidecar.json";

const DISK_MARGIN_BYTES = 64 * 1024 * 1024;

export class MigrationBackupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrationBackupError";
  }
}

export interface BackupSidecar {
  version: 1;
  backup: string;
  source: string;
  createdAt: string;
  pid: number;
  counts: Record<string, number>;
  schemaHash: string;
  projection: string;
  sequenceProjection: string;
  digest: string;
  sequenceDigest: string;
}

export interface MigrationBackup {
  path: string;
  sidecarPath: string;
  bytes: number;
}

export type BackupFinalization =
  | { status: "verified"; path: string; bytes: number }
  | { status: "basic"; path: string; bytes: number; reason: string }
  | { status: "duplicate-removed"; path: string; keptPath: string };

interface TableListRow {
  name: string;
  type: string;
  wr: number;
}

function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function listUserTables(sqlite: Database.Database): TableListRow[] {
  return sqlite
    .prepare(
      `SELECT name, type, wr FROM pragma_table_list WHERE schema = 'main' AND type IN ('table', 'virtual') AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name`,
    )
    .all() as TableListRow[];
}

export function countUserTables(
  sqlite: Database.Database,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const table of listUserTables(sqlite)) {
    const row = sqlite
      .prepare(`SELECT count(*) AS n FROM ${quoteIdentifier(table.name)}`)
      .get() as { n: number };
    counts[table.name] = row.n;
  }
  return counts;
}

interface NormalizedSchemaRow {
  type: string;
  name: string;
  tbl_name: string;
  sql: string | null;
}

export function normalizedSchema(
  sqlite: Database.Database,
): NormalizedSchemaRow[] {
  return sqlite
    .prepare(
      `SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite\\_stat%' ESCAPE '\\' AND NOT (type = 'table' AND name = 'sqlite_sequence') ORDER BY type, name`,
    )
    .all() as NormalizedSchemaRow[];
}

export function schemaHash(sqlite: Database.Database): string {
  return createHash("sha256")
    .update(JSON.stringify(normalizedSchema(sqlite)))
    .digest("hex");
}

function tableExists(sqlite: Database.Database, name: string): boolean {
  return (
    sqlite
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(name) !== undefined
  );
}

function updateTagged(hash: ReturnType<typeof createHash>, value: unknown) {
  const frame = (tag: number, bytes: Buffer): void => {
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(bytes.length));
    hash.update(Buffer.from([tag]));
    hash.update(length);
    hash.update(bytes);
  };
  if (value === null || value === undefined) {
    frame(0, Buffer.alloc(0));
  } else if (typeof value === "bigint") {
    frame(1, Buffer.from(value.toString(), "utf8"));
  } else if (typeof value === "number") {
    const bytes = Buffer.alloc(8);
    bytes.writeDoubleBE(value);
    frame(2, bytes);
  } else if (typeof value === "string") {
    frame(3, Buffer.from(value, "utf8"));
  } else if (Buffer.isBuffer(value)) {
    frame(4, value);
  } else {
    throw new MigrationBackupError("Unexpected SQLite value type in digest");
  }
}

export function contentDigest(sqlite: Database.Database): string {
  const hash = createHash("sha256");
  for (const row of normalizedSchema(sqlite)) {
    updateTagged(hash, row.type);
    updateTagged(hash, row.name);
    updateTagged(hash, row.tbl_name);
    updateTagged(hash, row.sql);
  }
  for (const table of listUserTables(sqlite)) {
    const columns = (
      sqlite
        .prepare(
          `SELECT name FROM pragma_table_xinfo(?) WHERE hidden = 0 ORDER BY cid`,
        )
        .all(table.name) as Array<{ name: string }>
    ).map((column) => quoteIdentifier(column.name));
    const hasRowid = table.wr === 0;
    const selected = hasRowid ? ["rowid", ...columns] : columns;
    const orderBy = hasRowid
      ? "rowid"
      : (
          sqlite
            .prepare(
              `SELECT name FROM pragma_table_info(?) WHERE pk > 0 ORDER BY pk`,
            )
            .all(table.name) as Array<{ name: string }>
        )
          .map((column) => quoteIdentifier(column.name))
          .join(", ");
    updateTagged(hash, table.name);
    const statement = sqlite
      .prepare(
        `SELECT ${selected.join(", ")} FROM ${quoteIdentifier(table.name)}${orderBy === "" ? "" : ` ORDER BY ${orderBy}`}`,
      )
      .raw(true)
      .safeIntegers(true);
    for (const row of statement.iterate() as IterableIterator<unknown[]>) {
      updateTagged(hash, row.length);
      for (const value of row) updateTagged(hash, value);
    }
  }
  return hash.digest("hex");
}

export function sequenceDigest(sqlite: Database.Database): string {
  const hash = createHash("sha256");
  if (tableExists(sqlite, "sqlite_sequence")) {
    const rows = sqlite
      .prepare("SELECT name, seq FROM sqlite_sequence ORDER BY name, seq")
      .raw(true)
      .safeIntegers(true)
      .all() as unknown[][];
    for (const row of rows) {
      for (const value of row) updateTagged(hash, value);
    }
  }
  return hash.digest("hex");
}

function fsyncPath(path: string): void {
  const handle = openSync(path, "r");
  try {
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
}

function writeSidecar(path: string, sidecar: BackupSidecar): void {
  const temporary = `${path}.tmp`;
  const handle = openSync(temporary, "w", 0o600);
  try {
    writeFileSync(handle, `${JSON.stringify(sidecar, null, 2)}\n`);
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
  renameSync(temporary, path);
  fsyncPath(dirname(path));
}

export function readSidecar(path: string): BackupSidecar | null {
  if (!existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "version" in parsed &&
      parsed.version === 1 &&
      "digest" in parsed &&
      typeof parsed.digest === "string" &&
      "sequenceDigest" in parsed &&
      typeof parsed.sequenceDigest === "string" &&
      "projection" in parsed &&
      typeof parsed.projection === "string"
    ) {
      return parsed as BackupSidecar;
    }
  } catch {
    return null;
  }
  return null;
}

function walBytes(databasePath: string): number {
  const wal = `${databasePath}-wal`;
  return existsSync(wal) ? statSync(wal).size : 0;
}

function assertDiskSpace(databasePath: string, destination: string): void {
  const databaseBytes = statSync(databasePath).size + walBytes(databasePath);
  const required = 2 * databaseBytes + DISK_MARGIN_BYTES;
  const stats = statfsSync(destination);
  const free = Number(stats.bavail) * Number(stats.bsize);
  try {
    accessSync(destination, constants.W_OK);
  } catch {
    throw new MigrationBackupError(
      `Cannot write a migration backup: ${destination} is not writable`,
    );
  }
  if (free < required) {
    throw new MigrationBackupError(
      `Not enough disk space for the migration backup in ${destination}: need ${required} bytes, ${free} free`,
    );
  }
  const temporaryDirectory = process.env.SQLITE_TMPDIR ?? tmpdir();
  let temporaryFree: number;
  try {
    const temporary = statfsSync(temporaryDirectory);
    temporaryFree = Number(temporary.bavail) * Number(temporary.bsize);
  } catch {
    throw new MigrationBackupError(
      `Cannot check temporary space for the migration backup: ${temporaryDirectory} is not available`,
    );
  }
  const temporaryRequired = databaseBytes + DISK_MARGIN_BYTES;
  if (temporaryFree < temporaryRequired) {
    throw new MigrationBackupError(
      `Not enough temporary space for the migration backup in ${temporaryDirectory}: need ${temporaryRequired} bytes, ${temporaryFree} free`,
    );
  }
}

function utcStamp(date: Date): string {
  return date
    .toISOString()
    .replaceAll(/[-:]/g, "")
    .replace(/\.(\d+)Z$/, "$1Z");
}

function sameCounts(
  left: Record<string, number>,
  right: Record<string, number>,
): boolean {
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => left[key] === right[key])
  );
}

function removeIfPresent(path: string): void {
  rmSync(path, { force: true });
}

export function createMigrationBackup(databasePath: string): MigrationBackup {
  const directory = dirname(databasePath);
  assertDiskSpace(databasePath, directory);
  const name = `${basename(databasePath)}${BACKUP_MARKER}${utcStamp(new Date())}-${process.pid}-${randomBytes(4).toString("hex")}`;
  const path = join(directory, name);
  const sidecarPath = `${path}${SIDECAR_SUFFIX}`;
  closeSync(openSync(path, "wx", 0o600));
  let source: Database.Database | undefined;
  let copy: Database.Database | undefined;
  try {
    source = new Database(databasePath, { readonly: true });
    source.pragma("synchronous = FULL");
    source.exec(`VACUUM INTO ${quoteLiteral(path)}`);
    copy = new Database(path, { readonly: true });
    const quick = copy.pragma("quick_check", { simple: true });
    if (quick !== "ok") {
      throw new MigrationBackupError(
        `Migration backup failed quick_check: ${String(quick)}`,
      );
    }
    const counts = countUserTables(source);
    if (!sameCounts(counts, countUserTables(copy))) {
      throw new MigrationBackupError(
        "Migration backup row counts differ from the database",
      );
    }
    const sourceSchema = schemaHash(source);
    if (sourceSchema !== schemaHash(copy)) {
      throw new MigrationBackupError(
        "Migration backup schema differs from the database",
      );
    }
    copy.close();
    copy = undefined;
    source.close();
    source = undefined;
    fsyncPath(path);
    fsyncPath(directory);
    writeSidecar(sidecarPath, {
      version: 1,
      backup: name,
      source: basename(databasePath),
      createdAt: new Date().toISOString(),
      pid: process.pid,
      counts,
      schemaHash: sourceSchema,
      projection: CONTENT_PROJECTION,
      sequenceProjection: SEQUENCE_PROJECTION,
      digest: "pending",
      sequenceDigest: "pending",
    });
    return { path, sidecarPath, bytes: statSync(path).size };
  } catch (error) {
    copy?.close();
    source?.close();
    removeIfPresent(path);
    removeIfPresent(`${path}-journal`);
    removeIfPresent(sidecarPath);
    removeIfPresent(`${sidecarPath}.tmp`);
    throw error instanceof MigrationBackupError
      ? error
      : new MigrationBackupError(
          `Migration backup failed: ${error instanceof Error ? error.message : String(error)}`,
        );
  }
}

function checkFts(database: Database.Database, path: string): void {
  const tables = database
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND sql LIKE 'CREATE VIRTUAL TABLE%USING fts5%'`,
    )
    .all() as Array<{ name: string }>;
  for (const table of tables) {
    try {
      database.exec("BEGIN");
      try {
        database
          .prepare(
            `INSERT INTO ${quoteIdentifier(table.name)}(${quoteIdentifier(table.name)}, rank) VALUES ('integrity-check', 1)`,
          )
          .run();
      } finally {
        database.exec("ROLLBACK");
      }
    } catch (error) {
      throw new MigrationBackupError(
        `${basename(path)} failed the FTS integrity check on ${table.name}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

export function digestsOf(path: string): { content: string; sequence: string } {
  const database = new Database(path, { fileMustExist: true });
  try {
    const integrity = database.pragma("integrity_check", { simple: true });
    if (integrity !== "ok") {
      throw new MigrationBackupError(
        `${basename(path)} failed integrity_check: ${String(integrity)}`,
      );
    }
    checkFts(database, path);
    return {
      content: contentDigest(database),
      sequence: sequenceDigest(database),
    };
  } finally {
    database.close();
  }
}

export function listMigrationBackups(databasePath: string): string[] {
  const directory = dirname(databasePath);
  const prefix = `${basename(databasePath)}${BACKUP_MARKER}`;
  return readdirSync(directory)
    .filter(
      (entry) =>
        entry.startsWith(prefix) &&
        !entry.endsWith(SIDECAR_SUFFIX) &&
        !entry.endsWith("-journal") &&
        !entry.endsWith(".tmp"),
    )
    .sort()
    .map((entry) => join(directory, entry));
}

function newestOlderBackup(
  databasePath: string,
  current: MigrationBackup,
): string | null {
  return (
    listMigrationBackups(databasePath)
      .filter((entry) => entry < current.path)
      .at(-1) ?? null
  );
}

export function discardMigrationBackup(backup: MigrationBackup): void {
  removeIfPresent(backup.path);
  removeIfPresent(backup.sidecarPath);
  removeIfPresent(`${backup.path}-journal`);
  fsyncPath(dirname(backup.path));
}

export function finalizeMigrationBackup(
  databasePath: string,
  backup: MigrationBackup,
): BackupFinalization {
  try {
    return finalizeUnchecked(databasePath, backup);
  } catch (error) {
    return {
      status: "basic",
      path: backup.path,
      bytes: backup.bytes,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

function finalizeUnchecked(
  databasePath: string,
  backup: MigrationBackup,
): BackupFinalization {
  const sidecar = readSidecar(backup.sidecarPath);
  if (sidecar === null) {
    return {
      status: "basic",
      path: backup.path,
      bytes: backup.bytes,
      reason: "sidecar missing",
    };
  }
  let digests: { content: string; sequence: string };
  try {
    digests = digestsOf(backup.path);
  } catch (error) {
    return {
      status: "basic",
      path: backup.path,
      bytes: backup.bytes,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  writeSidecar(backup.sidecarPath, {
    ...sidecar,
    digest: digests.content,
    sequenceDigest: digests.sequence,
  });

  const older = newestOlderBackup(databasePath, backup);
  if (older !== null) {
    const olderSidecar = readSidecar(`${older}${SIDECAR_SUFFIX}`);
    if (
      olderSidecar !== null &&
      olderSidecar.projection === CONTENT_PROJECTION &&
      olderSidecar.digest === digests.content &&
      olderSidecar.sequenceDigest === digests.sequence
    ) {
      try {
        const olderDigests = digestsOf(older);
        if (
          olderDigests.content === digests.content &&
          olderDigests.sequence === digests.sequence
        ) {
          removeIfPresent(backup.path);
          removeIfPresent(backup.sidecarPath);
          fsyncPath(dirname(databasePath));
          return {
            status: "duplicate-removed",
            path: backup.path,
            keptPath: older,
          };
        }
      } catch {
        return { status: "verified", path: backup.path, bytes: backup.bytes };
      }
    }
  }
  return { status: "verified", path: backup.path, bytes: backup.bytes };
}
