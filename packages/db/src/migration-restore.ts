import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  openSync,
  realpathSync,
  rmSync,
  statSync,
  statfsSync,
} from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";
import Database from "better-sqlite3";
import {
  BACKUP_MARKER,
  SIDECAR_SUFFIX,
  contentDigest,
  countUserTables,
  digestsOf,
  readSidecar,
  schemaHash,
  sequenceDigest,
  type BackupSidecar,
} from "./migration-backup.js";
import {
  acquireExclusiveInUseLock,
  acquireMigratingLock,
  type ExclusiveInUseLock,
  type MigratingLock,
} from "./migration-lock.js";

const DISK_MARGIN_BYTES = 64 * 1024 * 1024;

export class MigrationRestoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrationRestoreError";
  }
}

export interface RestoreOptions {
  databasePath?: string;
  checkOnly?: boolean;
}

export interface RestoreResult {
  mode: "check" | "restore";
  databasePath: string;
  backupPath: string;
  brokenCopyPath: string | null;
  tables: number;
  rows: number;
  counts: Record<string, number>;
  elapsedMs: number;
  nextStep: string;
}

export const RESTORE_NEXT_STEP =
  "Install the target (older) binary before restarting any process that uses this database.";

interface TableRow {
  name: string;
  type: string;
  wr: number;
}

interface MasterRow {
  type: string;
  name: string;
  sql: string | null;
}

function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
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

export function liveDatabasePathFor(backupPath: string): string {
  const index = basename(backupPath).lastIndexOf(BACKUP_MARKER);
  if (index <= 0) {
    throw new MigrationRestoreError(
      `${backupPath} does not look like a migration backup (no ${BACKUP_MARKER} in its name); pass the database path explicitly`,
    );
  }
  return join(dirname(backupPath), basename(backupPath).slice(0, index));
}

interface VerifiedBackup {
  realPath: string;
  sidecar: BackupSidecar;
  counts: Record<string, number>;
  contentDigest: string;
  sequenceDigest: string;
  bytes: number;
}

function verifyBackup(backupPath: string): VerifiedBackup {
  if (!existsSync(backupPath)) {
    throw new MigrationRestoreError(`Backup ${backupPath} does not exist`);
  }
  const bytes = statSync(backupPath).size;
  if (bytes === 0) {
    throw new MigrationRestoreError(`Backup ${backupPath} is empty`);
  }
  if (existsSync(`${backupPath}-journal`)) {
    throw new MigrationRestoreError(
      `Backup ${backupPath} has a -journal file beside it; refusing to touch it`,
    );
  }
  const sidecar = readSidecar(`${backupPath}${SIDECAR_SUFFIX}`);
  if (sidecar === null) {
    throw new MigrationRestoreError(
      `Backup ${backupPath} has no readable sidecar`,
    );
  }
  const realPath = realpathSync(backupPath);
  const digests = (() => {
    try {
      return digestsOf(realPath);
    } catch (error) {
      throw new MigrationRestoreError(
        error instanceof Error ? error.message : String(error),
      );
    }
  })();
  const database = new Database(realPath, {
    readonly: true,
    fileMustExist: true,
  });
  let counts: Record<string, number>;
  try {
    counts = countUserTables(database);
    if (Object.keys(counts).length === 0) {
      throw new MigrationRestoreError(
        `Backup ${backupPath} has no user tables; refusing to restore an empty database`,
      );
    }
    if (!sameCounts(counts, sidecar.counts)) {
      throw new MigrationRestoreError(
        `Backup ${backupPath} row counts differ from its sidecar`,
      );
    }
    if (schemaHash(database) !== sidecar.schemaHash) {
      throw new MigrationRestoreError(
        `Backup ${backupPath} schema differs from its sidecar`,
      );
    }
  } finally {
    database.close();
  }
  const finalized = sidecar.digest !== "pending";
  if (
    finalized &&
    (sidecar.digest !== digests.content ||
      sidecar.sequenceDigest !== digests.sequence)
  ) {
    throw new MigrationRestoreError(
      `Backup ${backupPath} content differs from its finalized sidecar digest`,
    );
  }
  return {
    realPath,
    sidecar,
    counts,
    contentDigest: digests.content,
    sequenceDigest: digests.sequence,
    bytes,
  };
}

function assertSpace(databasePath: string, backupBytes: number): void {
  const directory = dirname(databasePath);
  const liveBytes = statSync(databasePath).size;
  const required = liveBytes + 2 * backupBytes + DISK_MARGIN_BYTES;
  const stats = statfsSync(directory);
  const free = Number(stats.bavail) * Number(stats.bsize);
  if (free < required) {
    throw new MigrationRestoreError(
      `Not enough disk space in ${directory} to restore: need ${required} bytes, ${free} free`,
    );
  }
}

const PROBE_SCRIPT = `
const Database = require(process.argv[1]);
const results = [];
for (const path of process.argv.slice(2)) {
  let held = false;
  try {
    const db = new Database(path);
    db.pragma("busy_timeout = 0");
    try {
      db.exec("BEGIN");
      db.prepare("SELECT count(*) FROM sqlite_master").get();
      db.exec("ROLLBACK");
    } catch (error) {
      held = error && (error.code === "SQLITE_BUSY" || error.code === "SQLITE_LOCKED");
    }
    db.close();
  } catch (error) {
    held = error && (error.code === "SQLITE_BUSY" || error.code === "SQLITE_LOCKED");
  }
  results.push(held);
}
process.stdout.write(JSON.stringify(results));
`;

function probeLocksFromChild(paths: string[]): void {
  const require = createRequire(import.meta.url);
  const result = spawnSync(
    process.execPath,
    ["-e", PROBE_SCRIPT, require.resolve("better-sqlite3"), ...paths],
    { encoding: "utf8", timeout: 30_000 },
  );
  if (result.status !== 0) {
    throw new MigrationRestoreError(
      `The lock probe failed (exit ${String(result.status)}); refusing to restore`,
    );
  }
  let held: unknown;
  try {
    held = JSON.parse(result.stdout);
  } catch {
    throw new MigrationRestoreError(
      "The lock probe returned unreadable output; refusing to restore",
    );
  }
  if (
    !Array.isArray(held) ||
    held.length !== paths.length ||
    !held.every((value) => value === true)
  ) {
    throw new MigrationRestoreError(
      "A second process could still open the database; the exclusive lock does not hold, refusing to restore",
    );
  }
}

function readPragmaNumber(
  sqlite: Database.Database,
  schema: string,
  pragma: string,
): number {
  const row = sqlite.prepare(`PRAGMA ${schema}.${pragma}`).get() as Record<
    string,
    number
  >;
  return Object.values(row)[0] ?? 0;
}

function tableList(sqlite: Database.Database, schema: string): TableRow[] {
  return sqlite
    .prepare(
      `SELECT name, type, wr FROM pragma_table_list WHERE schema = ? AND type IN ('table', 'virtual') AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name`,
    )
    .all(schema) as TableRow[];
}

function writableColumns(
  sqlite: Database.Database,
  schema: string,
  table: string,
): Array<{ name: string; type: string; pk: number }> {
  return sqlite
    .prepare(
      `SELECT name, type, pk FROM pragma_table_xinfo(?, ?) WHERE hidden = 0 ORDER BY cid`,
    )
    .all(table, schema) as Array<{ name: string; type: string; pk: number }>;
}

function hasIntegerPrimaryKeyAlias(
  columns: Array<{ type: string; pk: number }>,
): boolean {
  const keys = columns.filter((column) => column.pk > 0);
  return keys.length === 1 && keys[0]?.type.toUpperCase() === "INTEGER";
}

function copyTable(
  sqlite: Database.Database,
  table: TableRow,
  virtual: boolean,
): void {
  const columns = writableColumns(sqlite, "bk", table.name);
  const names = columns.map((column) => quoteIdentifier(column.name));
  const includeRowid =
    table.wr === 0 && !hasIntegerPrimaryKeyAlias(columns) && !virtual;
  const virtualRowid = virtual;
  const targetColumns =
    includeRowid || virtualRowid ? ["rowid", ...names] : names;
  sqlite.exec(
    `INSERT INTO main.${quoteIdentifier(table.name)} (${targetColumns.join(", ")}) SELECT ${targetColumns.join(", ")} FROM bk.${quoteIdentifier(table.name)}`,
  );
}

function foreignKeyViolations(
  sqlite: Database.Database,
  schema: string,
): string[] {
  return (
    sqlite.prepare(`PRAGMA ${schema}.foreign_key_check`).raw(true).all() as [
      string,
      number | null,
      string,
      number,
    ][]
  )
    .map((row) => row.join("|"))
    .sort();
}

function sequenceRows(sqlite: Database.Database, schema: string): string[] {
  const exists =
    sqlite
      .prepare(
        `SELECT 1 FROM ${schema}.sqlite_master WHERE type = 'table' AND name = 'sqlite_sequence'`,
      )
      .get() !== undefined;
  if (!exists) return [];
  return (
    sqlite
      .prepare(`SELECT name, seq FROM ${schema}.sqlite_sequence`)
      .raw(true)
      .all() as [string, number][]
  )
    .map((row) => row.join("|"))
    .sort();
}

function schemaObjects(sqlite: Database.Database, schema: string) {
  return sqlite
    .prepare(
      `SELECT type, name, sql FROM ${schema}.sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY rowid`,
    )
    .all() as MasterRow[];
}

function rebuildFromBackup(sqlite: Database.Database): void {
  for (const row of schemaObjects(sqlite, "main").filter(
    (entry) => entry.type === "trigger",
  )) {
    sqlite.exec(`DROP TRIGGER main.${quoteIdentifier(row.name)}`);
  }
  for (const row of schemaObjects(sqlite, "main").filter(
    (entry) => entry.type === "view",
  )) {
    sqlite.exec(`DROP VIEW main.${quoteIdentifier(row.name)}`);
  }
  const live = tableList(sqlite, "main");
  const stats = sqlite
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'sqlite\\_stat%' ESCAPE '\\'`,
    )
    .all() as Array<{ name: string }>;
  for (const table of live) {
    sqlite.exec(`DROP TABLE main.${quoteIdentifier(table.name)}`);
  }
  for (const table of stats) {
    sqlite.exec(`DROP TABLE main.${quoteIdentifier(table.name)}`);
  }

  const objects = schemaObjects(sqlite, "bk");
  const backupTables = tableList(sqlite, "bk");
  const virtualNames = new Set(
    backupTables.filter((table) => table.type === "virtual").map((t) => t.name),
  );
  const ordinary = backupTables.filter((table) => table.type === "table");
  const create = (type: string, filter?: (row: MasterRow) => boolean): void => {
    for (const row of objects.filter(
      (entry) => entry.type === type && (filter?.(entry) ?? true),
    )) {
      if (row.sql !== null) sqlite.exec(row.sql);
    }
  };
  create("table", (row) => ordinary.some((table) => table.name === row.name));
  for (const table of ordinary) copyTable(sqlite, table, false);
  create("table", (row) => virtualNames.has(row.name));
  for (const table of backupTables.filter((t) => virtualNames.has(t.name))) {
    copyTable(sqlite, table, true);
  }

  const hasSequence =
    sqlite
      .prepare(
        `SELECT 1 FROM bk.sqlite_master WHERE type = 'table' AND name = 'sqlite_sequence'`,
      )
      .get() !== undefined;
  const liveHasSequence =
    sqlite
      .prepare(
        `SELECT 1 FROM main.sqlite_master WHERE type = 'table' AND name = 'sqlite_sequence'`,
      )
      .get() !== undefined;
  if (liveHasSequence) sqlite.exec("DELETE FROM main.sqlite_sequence");
  if (hasSequence) {
    if (!liveHasSequence) {
      throw new MigrationRestoreError(
        "The backup has sqlite_sequence rows but the rebuilt database has no AUTOINCREMENT table",
      );
    }
    sqlite.exec(
      "INSERT INTO main.sqlite_sequence (name, seq) SELECT name, seq FROM bk.sqlite_sequence",
    );
  }
  sqlite.exec(
    `PRAGMA main.user_version = ${readPragmaNumber(sqlite, "bk", "user_version")}`,
  );
  sqlite.exec(
    `PRAGMA main.application_id = ${readPragmaNumber(sqlite, "bk", "application_id")}`,
  );

  create("index");
  create("view");
  create("trigger");
}

function verifyRestored(
  sqlite: Database.Database,
  backup: VerifiedBackup,
  expectedViolations: string[],
  expectedSequence: string[],
): void {
  const integrity = sqlite.pragma("main.integrity_check", { simple: true });
  if (integrity !== "ok") {
    throw new MigrationRestoreError(
      `Restored database failed integrity_check: ${String(integrity)}`,
    );
  }
  if (!sameCounts(countUserTables(sqlite), backup.counts)) {
    throw new MigrationRestoreError(
      "Restored row counts differ from the backup",
    );
  }
  if (contentDigest(sqlite) !== backup.contentDigest) {
    throw new MigrationRestoreError(
      "Restored content (schema, rows or rowids) differs from the backup",
    );
  }
  if (sequenceDigest(sqlite) !== backup.sequenceDigest) {
    throw new MigrationRestoreError(
      "Restored sqlite_sequence differs from the backup",
    );
  }
  if (
    JSON.stringify(sequenceRows(sqlite, "main")) !==
    JSON.stringify(expectedSequence)
  ) {
    throw new MigrationRestoreError(
      "Restored sqlite_sequence rows differ from the backup",
    );
  }
  if (
    JSON.stringify(foreignKeyViolations(sqlite, "main")) !==
    JSON.stringify(expectedViolations)
  ) {
    throw new MigrationRestoreError(
      "Restored foreign key violations differ from the backup",
    );
  }
}

function summarize(counts: Record<string, number>): {
  tables: number;
  rows: number;
} {
  const values = Object.values(counts);
  return {
    tables: values.length,
    rows: values.reduce((sum, value) => sum + value, 0),
  };
}

export function restoreMigrationBackup(
  backupPath: string,
  options: RestoreOptions = {},
): RestoreResult {
  const startedAt = Date.now();
  const databasePath = options.databasePath ?? liveDatabasePathFor(backupPath);
  const verified = verifyBackup(backupPath);
  if (options.checkOnly === true) {
    return {
      mode: "check",
      databasePath,
      backupPath: verified.realPath,
      brokenCopyPath: null,
      ...summarize(verified.counts),
      counts: verified.counts,
      elapsedMs: Date.now() - startedAt,
      nextStep: RESTORE_NEXT_STEP,
    };
  }
  if (!existsSync(databasePath)) {
    throw new MigrationRestoreError(
      `Database ${databasePath} does not exist; nothing to restore over`,
    );
  }
  if (realpathSync(databasePath) === verified.realPath) {
    throw new MigrationRestoreError(
      "The backup and the database are the same file",
    );
  }
  assertSpace(databasePath, verified.bytes);

  let inUse: ExclusiveInUseLock | undefined;
  let migrating: MigratingLock | null = null;
  let sqlite: Database.Database | undefined;
  let brokenCopyPath: string | null = null;
  try {
    try {
      inUse = acquireExclusiveInUseLock(databasePath);
    } catch (error) {
      throw new MigrationRestoreError(
        error instanceof Error ? error.message : String(error),
      );
    }
    sqlite = new Database(databasePath, { fileMustExist: true });
    migrating = acquireMigratingLock(sqlite, { waitCapMs: 0 });
    sqlite.pragma("foreign_keys = OFF");
    if (sqlite.pragma("foreign_keys", { simple: true }) !== 0) {
      throw new MigrationRestoreError("Could not turn foreign_keys off");
    }
    sqlite.pragma("locking_mode = EXCLUSIVE");
    sqlite.exec("BEGIN IMMEDIATE");
    sqlite.exec(
      `PRAGMA main.user_version = ${readPragmaNumber(sqlite, "main", "user_version")}`,
    );
    sqlite.exec("COMMIT");
    probeLocksFromChild([inUse.lockPath, databasePath]);

    sqlite.exec(`ATTACH DATABASE ${quoteLiteral(verified.realPath)} AS bk`);
    const attached = sqlite
      .prepare(`SELECT file FROM pragma_database_list WHERE name = 'bk'`)
      .get() as { file: string } | undefined;
    if (
      attached === undefined ||
      realpathSync(attached.file) !== verified.realPath
    ) {
      throw new MigrationRestoreError(
        "The attached backup is not the verified backup file",
      );
    }
    const expectedViolations = foreignKeyViolations(sqlite, "bk");
    const expectedSequence = sequenceRows(sqlite, "bk");

    brokenCopyPath = `${databasePath}.broken-${utcStamp(new Date())}-${randomBytes(4).toString("hex")}`;
    closeSync(openSync(brokenCopyPath, "wx", 0o600));
    sqlite.exec(`VACUUM INTO ${quoteLiteral(brokenCopyPath)}`);

    sqlite.exec("BEGIN IMMEDIATE");
    try {
      rebuildFromBackup(sqlite);
      verifyRestored(sqlite, verified, expectedViolations, expectedSequence);
      sqlite.exec("COMMIT");
    } catch (error) {
      if (sqlite.inTransaction) sqlite.exec("ROLLBACK");
      throw error;
    }
    sqlite.pragma("foreign_keys = ON");
    if (sqlite.pragma("foreign_keys", { simple: true }) !== 1) {
      throw new MigrationRestoreError("Could not turn foreign_keys back on");
    }
    const after = countUserTables(sqlite);
    if (!sameCounts(after, verified.counts)) {
      throw new MigrationRestoreError(
        "Row counts changed after the restore committed",
      );
    }
    return {
      mode: "restore",
      databasePath,
      backupPath: verified.realPath,
      brokenCopyPath,
      ...summarize(after),
      counts: after,
      elapsedMs: Date.now() - startedAt,
      nextStep: RESTORE_NEXT_STEP,
    };
  } catch (error) {
    if (brokenCopyPath !== null && statSync(brokenCopyPath).size === 0) {
      rmSync(brokenCopyPath, { force: true });
    }
    throw error;
  } finally {
    try {
      sqlite?.close();
    } finally {
      migrating?.release();
      inUse?.release();
    }
  }
}
