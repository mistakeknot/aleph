import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  openSync,
  realpathSync,
  rmSync,
  statSync,
  statfsSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import Database from "better-sqlite3";
import {
  BACKUP_MARKER,
  CONTENT_PROJECTION,
  SEQUENCE_PROJECTION,
  SIDECAR_SUFFIX,
  contentDigest,
  countUserTables,
  digestsOf,
  readSidecar,
  rowidAlias,
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
  allowSourceMismatch?: boolean;
}

export type DigestVerification =
  | "compared"
  | "recomputed-projection-differs"
  | "recomputed-pending";

export interface RestoreResult {
  mode: "check" | "restore";
  databasePath: string;
  backupPath: string;
  brokenCopyPath: string | null;
  tables: number;
  rows: number;
  counts: Record<string, number>;
  digestVerification: DigestVerification;
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

function isLockedError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = "code" in error ? error.code : undefined;
  return (
    code === "SQLITE_BUSY" ||
    code === "SQLITE_LOCKED" ||
    (error instanceof Error && error.message.includes("database is locked"))
  );
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
  digestVerification: DigestVerification;
  bytes: number;
}

function isCounts(value: unknown): value is Record<string, number> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every(
      (entry) => typeof entry === "number" && Number.isInteger(entry),
    )
  );
}

type SqlToken =
  | { kind: "word"; value: string }
  | { kind: "identifier"; value: string }
  | { kind: "string"; value: string }
  | { kind: "punct"; value: string }
  | { kind: "comment"; value: string };

const CLOSING_QUOTES: Record<string, string> = {
  '"': '"',
  "`": "`",
  "'": "'",
  "[": "]",
};

function isWordCharacter(char: string): boolean {
  return /[A-Za-z0-9_$]/.test(char) || char.charCodeAt(0) > 127;
}

function tokenizeSql(sql: string): SqlToken[] | null {
  const tokens: SqlToken[] = [];
  let index = 0;
  while (index < sql.length) {
    const char = sql[index] ?? "";
    if (/\s/.test(char)) {
      index += 1;
    } else if (char === "-" && sql[index + 1] === "-") {
      const end = sql.indexOf("\n", index);
      tokens.push({ kind: "comment", value: "--" });
      index = end === -1 ? sql.length : end + 1;
    } else if (char === "/" && sql[index + 1] === "*") {
      const end = sql.indexOf("*/", index + 2);
      if (end === -1) return null;
      tokens.push({ kind: "comment", value: "/*" });
      index = end + 2;
    } else if (char in CLOSING_QUOTES) {
      const close = CLOSING_QUOTES[char] ?? char;
      let value = "";
      let cursor = index + 1;
      let closed = false;
      while (cursor < sql.length) {
        const next = sql[cursor] ?? "";
        if (next === close) {
          if (close !== "]" && sql[cursor + 1] === close) {
            value += close;
            cursor += 2;
            continue;
          }
          closed = true;
          cursor += 1;
          break;
        }
        value += next;
        cursor += 1;
      }
      if (!closed) return null;
      tokens.push({ kind: char === "'" ? "string" : "identifier", value });
      index = cursor;
    } else if (isWordCharacter(char)) {
      let cursor = index;
      while (cursor < sql.length && isWordCharacter(sql[cursor] ?? " ")) {
        cursor += 1;
      }
      tokens.push({ kind: "word", value: sql.slice(index, cursor) });
      index = cursor;
    } else {
      tokens.push({ kind: "punct", value: char });
      index += 1;
    }
  }
  return tokens;
}

const FTS5_ROUND_TRIP_OPTIONS = new Set([
  "tokenize",
  "prefix",
  "columnsize",
  "detail",
]);

function isName(token: SqlToken | undefined): token is SqlToken {
  return (
    token !== undefined &&
    (token.kind === "word" ||
      token.kind === "identifier" ||
      token.kind === "string")
  );
}

function isWord(token: SqlToken | undefined, word: string): boolean {
  return (
    token?.kind === "word" && token.value.toLowerCase() === word.toLowerCase()
  );
}

function isPunct(token: SqlToken | undefined, value: string): boolean {
  return token?.kind === "punct" && token.value === value;
}

function fts5ArgumentsRoundTrip(tokens: SqlToken[], from: number): boolean {
  if (!isPunct(tokens[from], "(")) return false;
  const args: SqlToken[][] = [[]];
  let depth = 1;
  let index = from + 1;
  for (; index < tokens.length && depth > 0; index += 1) {
    const token = tokens[index] as SqlToken;
    if (isPunct(token, "(")) depth += 1;
    if (isPunct(token, ")")) depth -= 1;
    if (depth === 0) break;
    if (depth === 1 && isPunct(token, ",")) args.push([]);
    else args[args.length - 1]?.push(token);
  }
  if (depth !== 0) return false;
  if (!tokens.slice(index + 1).every((token) => isPunct(token, ";"))) {
    return false;
  }
  return args.every((arg) => {
    if (isName(arg[0]) && arg.length === 1) return true;
    if (isName(arg[0]) && arg.length === 2 && isWord(arg[1], "UNINDEXED")) {
      return true;
    }
    return (
      isName(arg[0]) &&
      isPunct(arg[1], "=") &&
      isName(arg[2]) &&
      arg.length === 3 &&
      FTS5_ROUND_TRIP_OPTIONS.has(arg[0].value.toLowerCase())
    );
  });
}

interface VirtualTableScan {
  hasComment: boolean;
  module: string | null;
  fts5ArgumentsRoundTrip: boolean;
}

function scanVirtualTable(sql: string): VirtualTableScan | null {
  const tokens = tokenizeSql(sql);
  if (tokens === null) return null;
  const hasComment = tokens.some((token) => token.kind === "comment");
  const unreadable = {
    hasComment,
    module: null,
    fts5ArgumentsRoundTrip: false,
  };
  if (hasComment) return unreadable;
  let index = 0;
  for (const word of ["CREATE", "VIRTUAL", "TABLE"]) {
    if (!isWord(tokens[index], word)) return unreadable;
    index += 1;
  }
  if (isWord(tokens[index], "IF")) {
    if (
      !isWord(tokens[index + 1], "NOT") ||
      !isWord(tokens[index + 2], "EXISTS")
    ) {
      return unreadable;
    }
    index += 3;
  }
  if (!isName(tokens[index])) return unreadable;
  index += 1;
  if (isPunct(tokens[index], ".")) {
    if (!isName(tokens[index + 1])) return unreadable;
    index += 2;
  }
  if (!isWord(tokens[index], "USING")) return unreadable;
  const module = tokens[index + 1];
  if (!isName(module)) return unreadable;
  const name = module.value.toLowerCase();
  return {
    hasComment,
    module: name,
    fts5ArgumentsRoundTrip:
      name === "fts5" && fts5ArgumentsRoundTrip(tokens, index + 2),
  };
}

function assertFtsIndexesRestorable(
  database: Database.Database,
  backupPath: string,
): void {
  const names = new Set(
    (
      database
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
        .all() as Array<{ name: string }>
    ).map((row) => row.name),
  );
  const virtual = database
    .prepare(
      `SELECT name, sql FROM sqlite_master WHERE type = 'table' AND sql LIKE 'CREATE VIRTUAL TABLE%'`,
    )
    .all() as Array<{ name: string; sql: string }>;
  for (const { name, sql } of virtual) {
    const scan = scanVirtualTable(sql);
    if (scan?.hasComment === true) {
      throw new MigrationRestoreError(
        `Backup ${backupPath} has the virtual table ${name} whose definition contains an SQL comment; refusing to restore`,
      );
    }
    if (scan === null || scan.module === null) {
      throw new MigrationRestoreError(
        `Backup ${backupPath} has the virtual table ${name} whose module could not be read; refusing to restore`,
      );
    }
    if (scan.module !== "fts5") continue;
    const complete = ["content", "config", "data"].every((suffix) =>
      names.has(`${name}_${suffix}`),
    );
    if (!complete || !scan.fts5ArgumentsRoundTrip) {
      throw new MigrationRestoreError(
        `Backup ${backupPath} contains the FTS5 table ${name}, which is contentless, external-content or uses options a restore cannot preserve; refusing to restore`,
      );
    }
    const settings = database
      .prepare(
        `SELECT count(*) AS n FROM ${quoteIdentifier(`${name}_config`)} WHERE k <> 'version'`,
      )
      .get() as { n: number };
    if (settings.n !== 0) {
      throw new MigrationRestoreError(
        `Backup ${backupPath} has the FTS5 table ${name} with persistent settings (such as rank or automerge) that a restore cannot preserve; refusing to restore`,
      );
    }
  }
}

function assertRowidsAddressable(
  database: Database.Database,
  backupPath: string,
): void {
  const tables = database
    .prepare(
      `SELECT name FROM pragma_table_list WHERE schema = 'main' AND type IN ('table', 'virtual') AND wr = 0 AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'`,
    )
    .all() as Array<{ name: string }>;
  for (const { name } of tables) {
    if (rowidAlias(database, "main", name) === null) {
      throw new MigrationRestoreError(
        `Backup ${backupPath} has the table ${name} whose columns shadow rowid, _rowid_ and oid, so its row ids cannot be read; refusing to restore`,
      );
    }
  }
}

function digestsOfPrivateCopy(realPath: string): {
  content: string;
  sequence: string;
} {
  const required = statSync(realPath).size + DISK_MARGIN_BYTES;
  const stats = statfsSync(tmpdir());
  const free = Number(stats.bavail) * Number(stats.bsize);
  if (free < required) {
    throw new MigrationRestoreError(
      `Not enough disk space in ${tmpdir()} to verify the backup: need ${required} bytes, ${free} free`,
    );
  }
  const directory = mkdtempSync(join(tmpdir(), "bb-restore-verify-"));
  try {
    const copy = join(directory, "backup.db");
    copyFileSync(realPath, copy);
    chmodSync(copy, 0o600);
    return digestsOf(copy);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function verifyBackup(backupPath: string): VerifiedBackup {
  if (!existsSync(backupPath)) {
    throw new MigrationRestoreError(`Backup ${backupPath} does not exist`);
  }
  const bytes = statSync(backupPath).size;
  if (bytes === 0) {
    throw new MigrationRestoreError(`Backup ${backupPath} is empty`);
  }
  for (const suffix of ["-journal", "-wal"]) {
    if (existsSync(`${backupPath}${suffix}`)) {
      throw new MigrationRestoreError(
        `Backup ${backupPath} has a ${suffix} file beside it; refusing to touch it`,
      );
    }
  }
  const sidecar = readSidecar(`${backupPath}${SIDECAR_SUFFIX}`);
  if (sidecar === null) {
    throw new MigrationRestoreError(
      `Backup ${backupPath} has no readable sidecar`,
    );
  }
  if (
    !isCounts(sidecar.counts) ||
    typeof sidecar.schemaHash !== "string" ||
    typeof sidecar.source !== "string"
  ) {
    throw new MigrationRestoreError(
      `Backup ${backupPath} has a sidecar missing its counts, schema hash or source`,
    );
  }
  const realPath = realpathSync(backupPath);
  const shape = new Database(realPath, { readonly: true, fileMustExist: true });
  try {
    assertFtsIndexesRestorable(shape, backupPath);
    assertRowidsAddressable(shape, backupPath);
  } finally {
    shape.close();
  }
  const digests = (() => {
    try {
      return digestsOfPrivateCopy(realPath);
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
  const digestVerification: DigestVerification =
    sidecar.digest === "pending"
      ? "recomputed-pending"
      : sidecar.projection === CONTENT_PROJECTION &&
          sidecar.sequenceProjection === SEQUENCE_PROJECTION
        ? "compared"
        : "recomputed-projection-differs";
  if (
    digestVerification === "compared" &&
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
    digestVerification,
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

function copyTable(
  sqlite: Database.Database,
  table: TableRow,
  virtual: boolean,
): void {
  const columns = writableColumns(sqlite, "bk", table.name);
  const names = columns.map((column) => quoteIdentifier(column.name));
  const alias =
    table.wr === 0 || virtual ? rowidAlias(sqlite, "bk", table.name) : null;
  if ((table.wr === 0 || virtual) && alias === null) {
    throw new MigrationRestoreError(
      `The table ${table.name} has no readable rowid; refusing to restore`,
    );
  }
  const targetColumns = alias === null ? names : [alias, ...names];
  sqlite.exec(
    `INSERT INTO main.${quoteIdentifier(table.name)} (${targetColumns.join(", ")}) SELECT ${targetColumns.join(", ")} FROM bk.${quoteIdentifier(table.name)}`,
  );
}

function verifyRowids(sqlite: Database.Database): void {
  for (const table of tableList(sqlite, "bk")) {
    if (table.wr !== 0 && table.type !== "virtual") continue;
    const alias = rowidAlias(sqlite, "bk", table.name);
    if (alias === null || alias === "rowid") continue;
    const columns = writableColumns(sqlite, "bk", table.name).map((column) =>
      quoteIdentifier(column.name),
    );
    const selected = [alias, ...columns].join(", ");
    const name = quoteIdentifier(table.name);
    const differing = sqlite
      .prepare(
        `SELECT count(*) AS n FROM (SELECT ${selected} FROM main.${name} EXCEPT SELECT ${selected} FROM bk.${name}) UNION ALL SELECT count(*) FROM (SELECT ${selected} FROM bk.${name} EXCEPT SELECT ${selected} FROM main.${name})`,
      )
      .all() as Array<{ n: number }>;
    if (differing.some((row) => row.n !== 0)) {
      throw new MigrationRestoreError(
        `Restored row ids of ${table.name} differ from the backup`,
      );
    }
  }
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
  verifyRowids(sqlite);
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
  if (
    verified.sidecar.source !== basename(databasePath) &&
    options.allowSourceMismatch !== true
  ) {
    throw new MigrationRestoreError(
      `Backup ${backupPath} was taken from ${verified.sidecar.source}, not ${basename(databasePath)}; pass allowSourceMismatch (--allow-source-mismatch) to restore it anyway`,
    );
  }
  if (options.checkOnly === true) {
    return {
      mode: "check",
      databasePath,
      backupPath: verified.realPath,
      brokenCopyPath: null,
      ...summarize(verified.counts),
      counts: verified.counts,
      digestVerification: verified.digestVerification,
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
      digestVerification: verified.digestVerification,
      elapsedMs: Date.now() - startedAt,
      nextStep: RESTORE_NEXT_STEP,
    };
  } catch (error) {
    if (
      brokenCopyPath !== null &&
      existsSync(brokenCopyPath) &&
      statSync(brokenCopyPath).size === 0
    ) {
      rmSync(brokenCopyPath, { force: true });
    }
    if (isLockedError(error)) {
      throw new MigrationRestoreError(
        `Another process is using ${databasePath}; stop the server and daemon before restoring`,
      );
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
