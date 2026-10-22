import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import {
  COMPAT_LOG_TABLE,
  MIGRATION_LEDGER_TABLE,
} from "./migration-ledger.js";

export const FROZEN_ALEPH_STEP_IDS: ReadonlySet<string> = new Set([
  "A0001",
  "A0002",
  "A0003",
  "A0004",
  "A0005",
  "A0006",
  "A0007",
  "A0008",
]);

const FTS_TABLE = "thread_search_segments_fts";
const SEGMENTS_TABLE = "thread_search_segments";
const MODULUS = 1n << 128n;

export class MigrationStepCheckError extends Error {
  constructor(
    readonly stepId: string,
    message: string,
  ) {
    super(`Migration step ${stepId} failed its safety check: ${message}`);
    this.name = "MigrationStepCheckError";
  }
}

export interface CopiedTableDeclaration {
  table: string;
  preservedColumns: readonly string[];
  columnRenames: Readonly<Record<string, string>>;
}

export interface StepChecks {
  createsTables: readonly string[];
  dropsTables: readonly string[];
  writesTables: readonly string[];
  copiedTables: readonly CopiedTableDeclaration[];
  rowDeltas: Readonly<Record<string, number>>;
  renumbersRowids: readonly string[];
  tableRenames: Readonly<Record<string, string>>;
  columnRenames: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

export const EMPTY_STEP_CHECKS: StepChecks = {
  createsTables: [],
  dropsTables: [],
  writesTables: [],
  copiedTables: [],
  rowDeltas: {},
  renumbersRowids: [],
  tableRenames: {},
  columnRenames: {},
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringList(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`Step checks ${label} must be a list of strings`);
  }
  return value as string[];
}

function stringMap(value: unknown, label: string): Record<string, string> {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new Error(`Step checks ${label} must be a map`);
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string") {
      throw new Error(`Step checks ${label}.${key} must be a string`);
    }
    out[key] = item;
  }
  return out;
}

function parseStepChecks(id: string, raw: unknown): StepChecks {
  if (!isRecord(raw))
    throw new Error(`Step checks for ${id} must be an object`);
  const known = new Set([
    "createsTables",
    "dropsTables",
    "writesTables",
    "copiedTables",
    "rowDeltas",
    "renumbersRowids",
    "tableRenames",
    "columnRenames",
  ]);
  for (const key of Object.keys(raw)) {
    if (!known.has(key)) {
      throw new Error(`Step checks for ${id} has unknown field ${key}`);
    }
  }
  const copied = raw.copiedTables ?? [];
  if (!Array.isArray(copied)) {
    throw new Error(`Step checks for ${id} copiedTables must be a list`);
  }
  const rowDeltas: Record<string, number> = {};
  if (raw.rowDeltas !== undefined) {
    if (!isRecord(raw.rowDeltas)) {
      throw new Error(`Step checks for ${id} rowDeltas must be a map`);
    }
    for (const [table, delta] of Object.entries(raw.rowDeltas)) {
      if (typeof delta !== "number" || !Number.isInteger(delta)) {
        throw new Error(`Step checks for ${id} rowDeltas.${table} is invalid`);
      }
      rowDeltas[table] = delta;
    }
  }
  const columnRenames: Record<string, Record<string, string>> = {};
  if (raw.columnRenames !== undefined) {
    if (!isRecord(raw.columnRenames)) {
      throw new Error(`Step checks for ${id} columnRenames must be a map`);
    }
    for (const [table, map] of Object.entries(raw.columnRenames)) {
      columnRenames[table] = stringMap(map, `columnRenames.${table}`);
    }
  }
  return {
    createsTables: stringList(raw.createsTables, "createsTables"),
    dropsTables: stringList(raw.dropsTables, "dropsTables"),
    writesTables: stringList(raw.writesTables, "writesTables"),
    copiedTables: copied.map((entry) => {
      if (!isRecord(entry) || typeof entry.table !== "string") {
        throw new Error(`Step checks for ${id} has an invalid copied table`);
      }
      return {
        table: entry.table,
        preservedColumns: stringList(
          entry.preservedColumns,
          "preservedColumns",
        ),
        columnRenames: stringMap(entry.columnRenames, "columnRenames"),
      };
    }),
    rowDeltas,
    renumbersRowids: stringList(raw.renumbersRowids, "renumbersRowids"),
    tableRenames: stringMap(raw.tableRenames, "tableRenames"),
    columnRenames,
  };
}

export function loadStepChecks(
  alephFolder: string,
): ReadonlyMap<string, StepChecks> {
  const path = join(alephFolder, "step-checks.json");
  if (!existsSync(path)) return new Map();
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(raw)) throw new Error("step-checks.json must be an object");
  return new Map(
    Object.entries(raw).map(([id, value]) => [id, parseStepChecks(id, value)]),
  );
}

interface TableColumn {
  name: string;
  pk: number;
  notNull: boolean;
}

interface UserTable {
  name: string;
  virtual: boolean;
  columns: TableColumn[];
  keyColumns: string[] | null;
  nullableKey: boolean;
}

interface TableMeasure {
  count: number;
  digest: bigint;
}

export interface StepSnapshot {
  tables: Map<string, UserTable>;
  measures: Map<string, TableMeasure>;
  counters: Map<string, number>;
  counterRows: Map<string, number>;
  triggerWrites: Map<string, Set<string>>;
}

function fold(name: string): string {
  return name.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

function quote(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function listUserTables(sqlite: Database.Database): UserTable[] {
  const rows = sqlite
    .prepare(
      "SELECT name, type FROM pragma_table_list WHERE schema = 'main' AND type IN ('table', 'virtual') AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name",
    )
    .all() as Array<{ name: string; type: string }>;
  const tables: UserTable[] = [];
  for (const row of rows) {
    if (row.name === COMPAT_LOG_TABLE || row.name === MIGRATION_LEDGER_TABLE) {
      continue;
    }
    const columns = (
      sqlite
        .prepare(
          'SELECT name, pk, "notnull" AS required FROM pragma_table_xinfo(?) WHERE hidden = 0 ORDER BY cid',
        )
        .all(row.name) as Array<{ name: string; pk: number; required: number }>
    ).map((column) => ({
      name: column.name,
      pk: column.pk,
      notNull: column.required === 1,
    }));
    const virtual = row.type === "virtual";
    const pkColumns = columns
      .filter((column) => column.pk > 0)
      .sort((a, b) => a.pk - b.pk);
    let keyColumns: string[] | null = null;
    let nullableKey = false;
    if (pkColumns.length > 0) {
      keyColumns = pkColumns.map((column) => column.name);
      nullableKey = pkColumns.some((column) => !column.notNull);
    } else if (!virtual) {
      const indexes = sqlite
        .prepare(
          'SELECT name FROM pragma_index_list(?) WHERE "unique" = 1 AND partial = 0 ORDER BY seq',
        )
        .all(row.name) as Array<{ name: string }>;
      for (const index of indexes) {
        const indexColumns = sqlite
          .prepare("SELECT name FROM pragma_index_info(?) ORDER BY seqno")
          .all(index.name) as Array<{ name: string | null }>;
        const names = indexColumns.map((column) => column.name);
        if (
          names.every(
            (name): name is string =>
              name !== null &&
              columns.some((column) => column.name === name && column.notNull),
          )
        ) {
          keyColumns = names;
          break;
        }
      }
    }
    tables.push({ name: row.name, virtual, columns, keyColumns, nullableKey });
  }
  return tables;
}

function sqlTag(sqlType: string): number {
  switch (sqlType) {
    case "null":
      return 0;
    case "integer":
      return 1;
    case "real":
      return 2;
    case "text":
      return 3;
    default:
      return 4;
  }
}

function hashValues(
  values: ReadonlyArray<{ type: string; value: unknown }>,
): bigint {
  const hash = createHash("sha256");
  for (const { type, value } of values) {
    const bytes =
      value === null || value === undefined
        ? Buffer.alloc(0)
        : Buffer.isBuffer(value)
          ? value
          : Buffer.from(String(value), "utf8");
    const header = Buffer.alloc(9);
    header.writeUInt8(sqlTag(type), 0);
    header.writeBigUInt64BE(BigInt(bytes.length), 1);
    hash.update(header);
    hash.update(bytes);
  }
  return BigInt(`0x${hash.digest().subarray(0, 16).toString("hex")}`);
}

function measureTable(
  sqlite: Database.Database,
  table: UserTable,
  options: { includeRowid: boolean; columns?: readonly string[] },
): TableMeasure {
  const columns = options.columns ?? table.columns.map((column) => column.name);
  const selected = columns
    .flatMap((column) => [quote(column), `typeof(${quote(column)})`])
    .join(", ");
  const statement = sqlite
    .prepare(
      options.includeRowid
        ? `SELECT rowid, ${selected} FROM ${quote(table.name)}`
        : `SELECT ${selected} FROM ${quote(table.name)}`,
    )
    .raw();
  let count = 0;
  let digest = 0n;
  for (const row of statement.iterate() as IterableIterator<unknown[]>) {
    const parts: Array<{ type: string; value: unknown }> = [];
    let offset = 0;
    if (options.includeRowid) {
      parts.push({ type: "integer", value: row[0] });
      offset = 1;
    }
    for (let index = 0; index < columns.length; index += 1) {
      parts.push({
        type: String(row[offset + index * 2 + 1]),
        value: row[offset + index * 2],
      });
    }
    digest = (digest + hashValues(parts)) % MODULUS;
    count += 1;
  }
  return { count, digest };
}

const TRIGGER_WRITE =
  /\b(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|UPDATE(?:\s+OR\s+\w+)?|DELETE\s+FROM|REPLACE\s+INTO)\s+[`"[]?(\w+)/gi;

function triggerWriteGraph(
  sqlite: Database.Database,
): Map<string, Set<string>> {
  const graph = new Map<string, Set<string>>();
  const rows = sqlite
    .prepare(
      "SELECT tbl_name AS tableName, sql FROM sqlite_master WHERE type = 'trigger' AND sql IS NOT NULL",
    )
    .all() as Array<{ tableName: string; sql: string }>;
  for (const row of rows) {
    const body = row.sql.slice(row.sql.search(/\bBEGIN\b/i));
    const written = graph.get(row.tableName) ?? new Set<string>();
    for (const match of body.matchAll(TRIGGER_WRITE)) {
      const target = match[1];
      if (target !== undefined) written.add(target);
    }
    graph.set(row.tableName, written);
  }
  return graph;
}

export function triggerClosure(
  graph: ReadonlyMap<string, ReadonlySet<string>>,
  roots: Iterable<string>,
): Set<string> {
  const seen = new Set<string>();
  const queue = [...roots];
  for (let next = queue.pop(); next !== undefined; next = queue.pop()) {
    for (const target of graph.get(next) ?? []) {
      if (!seen.has(target)) {
        seen.add(target);
        queue.push(target);
      }
    }
  }
  return seen;
}

function readSequence(sqlite: Database.Database): {
  counters: Map<string, number>;
  rows: Map<string, number>;
} {
  const counters = new Map<string, number>();
  const rows = new Map<string, number>();
  const exists = sqlite
    .prepare("SELECT 1 FROM sqlite_master WHERE name = 'sqlite_sequence'")
    .get();
  if (exists === undefined) return { counters, rows };
  for (const row of sqlite
    .prepare("SELECT name, seq FROM sqlite_sequence")
    .all() as Array<{ name: string; seq: number }>) {
    counters.set(row.name, Math.max(counters.get(row.name) ?? 0, row.seq));
    rows.set(row.name, (rows.get(row.name) ?? 0) + 1);
  }
  return { counters, rows };
}

function requireKeys(stepId: string, tables: readonly UserTable[]): void {
  for (const table of tables) {
    if (table.name === FTS_TABLE) continue;
    if (table.keyColumns === null) {
      throw new MigrationStepCheckError(
        stepId,
        `table ${table.name} has no declared key (primary key or NOT NULL unique index)`,
      );
    }
  }
}

export function captureStepSnapshot(
  sqlite: Database.Database,
  stepId: string,
  includeRowid: (table: string) => boolean,
): StepSnapshot {
  const list = listUserTables(sqlite);
  requireKeys(stepId, list);
  const tables = new Map(list.map((table) => [table.name, table]));
  const measures = new Map<string, TableMeasure>();
  for (const table of list) {
    measures.set(
      table.name,
      measureTable(sqlite, table, { includeRowid: includeRowid(table.name) }),
    );
  }
  const sequence = readSequence(sqlite);
  return {
    tables,
    measures,
    counters: sequence.counters,
    counterRows: sequence.rows,
    triggerWrites: triggerWriteGraph(sqlite),
  };
}

function keyJson(table: UserTable): string {
  const keys = table.keyColumns ?? [];
  return `json_array(${keys
    .map((key) => `${quote(key)}, typeof(${quote(key)})`)
    .join(", ")})`;
}

function keyNotNull(table: UserTable): string {
  return (table.keyColumns ?? [])
    .map((key) => `${quote(key)} IS NOT NULL`)
    .join(" AND ");
}

export interface RowidBaseline {
  temp: Map<string, string>;
}

let baselineCounter = 0;

export function captureRowidBaseline(
  sqlite: Database.Database,
  snapshot: StepSnapshot,
  skip: (table: string) => boolean,
): RowidBaseline {
  const temp = new Map<string, string>();
  for (const table of snapshot.tables.values()) {
    if (table.virtual || table.keyColumns === null || skip(table.name))
      continue;
    baselineCounter += 1;
    const name = `bb_chk_rowids_${baselineCounter}`;
    sqlite.exec(
      `CREATE TEMP TABLE ${name} AS SELECT ${keyJson(table)} AS k, rowid AS r FROM main.${quote(table.name)} WHERE ${keyNotNull(table)}`,
    );
    temp.set(table.name, name);
  }
  return { temp };
}

export function dropRowidBaseline(
  sqlite: Database.Database,
  baseline: RowidBaseline,
): void {
  for (const name of baseline.temp.values()) {
    sqlite.exec(`DROP TABLE IF EXISTS temp.${name}`);
  }
}

interface DriftCapture {
  temp: string | null;
}

function driftSql(): string {
  return `SELECT 'segment' AS side, s.rowid AS id, s.text AS text FROM main.${SEGMENTS_TABLE} s WHERE NOT EXISTS (SELECT 1 FROM main.${FTS_TABLE} f WHERE f.rowid = s.rowid AND f.text IS s.text)
    UNION ALL SELECT 'fts', f.rowid, f.text FROM main.${FTS_TABLE} f WHERE NOT EXISTS (SELECT 1 FROM main.${SEGMENTS_TABLE} s WHERE s.rowid = f.rowid AND s.text IS f.text)`;
}

export function captureFtsDrift(
  sqlite: Database.Database,
  snapshot: StepSnapshot,
): DriftCapture {
  if (!snapshot.tables.has(SEGMENTS_TABLE) || !snapshot.tables.has(FTS_TABLE)) {
    return { temp: null };
  }
  baselineCounter += 1;
  const name = `bb_chk_drift_${baselineCounter}`;
  sqlite.exec(`CREATE TEMP TABLE ${name} AS ${driftSql()}`);
  return { temp: name };
}

export interface PreservedBaseline {
  digests: Map<string, bigint>;
  counts: Map<string, number>;
}

export function capturePreserved(
  sqlite: Database.Database,
  snapshot: StepSnapshot,
  checks: StepChecks,
): PreservedBaseline {
  const digests = new Map<string, bigint>();
  const counts = new Map<string, number>();
  for (const copied of checks.copiedTables) {
    const table = snapshot.tables.get(copied.table);
    if (table === undefined) continue;
    const measured = measureTable(sqlite, table, {
      includeRowid: false,
      columns: preservedWithKey(table, copied.preservedColumns),
    });
    digests.set(copied.table, measured.digest);
    counts.set(copied.table, measured.count);
  }
  return { digests, counts };
}

function preservedWithKey(
  table: UserTable,
  preserved: readonly string[],
): string[] {
  return [...new Set([...(table.keyColumns ?? []), ...preserved])];
}

export interface StepBaseline {
  snapshot: StepSnapshot;
  rowids: RowidBaseline;
  drift: DriftCapture;
  preserved: PreservedBaseline;
}

export function captureStepBaseline(
  sqlite: Database.Database,
  stepId: string,
  checks: StepChecks | null,
  guarded: ReadonlySet<string> | null,
): StepBaseline {
  const declared = checks ?? EMPTY_STEP_CHECKS;
  const renumbers = new Set(declared.renumbersRowids);
  const snapshot = captureStepSnapshot(
    sqlite,
    stepId,
    (table) => !renumbers.has(table),
  );
  const rowids = captureRowidBaseline(sqlite, snapshot, (table) =>
    shouldSkipRowid(table, renumbers, guarded),
  );
  return {
    snapshot,
    rowids,
    drift: captureFtsDrift(sqlite, snapshot),
    preserved: capturePreserved(sqlite, snapshot, declared),
  };
}

function shouldSkipRowid(
  table: string,
  renumbers: ReadonlySet<string>,
  guarded: ReadonlySet<string> | null,
): boolean {
  if (renumbers.has(table)) return true;
  return guarded !== null && !guarded.has(fold(table));
}

function fail(stepId: string, message: string): never {
  throw new MigrationStepCheckError(stepId, message);
}

export function verifyStep(
  sqlite: Database.Database,
  stepId: string,
  checks: StepChecks | null,
  guarded: ReadonlySet<string> | null,
  baseline: StepBaseline,
): void {
  const declared = checks ?? EMPTY_STEP_CHECKS;
  const restricted = checks === null && guarded !== null;
  const renumbers = new Set(declared.renumbersRowids);
  const after = captureStepSnapshot(
    sqlite,
    stepId,
    (table) => !renumbers.has(table),
  );
  const before = baseline.snapshot;
  const inScope = (table: string): boolean =>
    !restricted || (guarded?.has(fold(table)) ?? false);

  const creates = new Set(declared.createsTables);
  const drops = new Set(declared.dropsTables);
  const copied = new Map(
    declared.copiedTables.map((entry) => [entry.table, entry]),
  );
  const directWrites = new Set([
    ...declared.writesTables,
    ...copied.keys(),
    ...creates,
    ...drops,
  ]);
  const triggerTargets = triggerClosure(after.triggerWrites, [
    ...declared.writesTables,
    ...copied.keys(),
  ]);
  for (const target of triggerTargets) {
    if (
      after.tables.has(target) &&
      !directWrites.has(target) &&
      declared.writesTables.length + copied.size > 0 &&
      !restricted
    ) {
      fail(
        stepId,
        `table ${target} is written by triggers of a declared table but is not declared in writesTables`,
      );
    }
  }
  for (const [name, table] of before.tables) {
    void table;
    if (!after.tables.has(name) && !drops.has(name) && inScope(name)) {
      fail(stepId, `table ${name} was dropped without being declared`);
    }
  }
  for (const name of after.tables.keys()) {
    if (!before.tables.has(name) && !creates.has(name) && inScope(name)) {
      fail(stepId, `table ${name} was created without being declared`);
    }
  }
  for (const name of drops) {
    if (after.tables.has(name)) {
      fail(stepId, `table ${name} is declared dropped but still exists`);
    }
  }

  for (const [name, beforeMeasure] of before.measures) {
    const afterMeasure = after.measures.get(name);
    if (afterMeasure === undefined || !inScope(name)) continue;
    const delta = declared.rowDeltas[name] ?? 0;
    if (afterMeasure.count - beforeMeasure.count !== delta) {
      fail(
        stepId,
        `table ${name} row count changed from ${beforeMeasure.count} to ${afterMeasure.count}, expected a change of ${delta}`,
      );
    }
    if (!directWrites.has(name) && !triggerTargets.has(name)) {
      if (afterMeasure.digest !== beforeMeasure.digest) {
        fail(
          stepId,
          `table ${name} content changed but the step does not declare it`,
        );
      }
    }
  }
  for (const name of creates) {
    const table = after.tables.get(name);
    if (table === undefined) {
      fail(stepId, `table ${name} is declared created but does not exist`);
    }
    const expected = declared.rowDeltas[name] ?? 0;
    const actual = after.measures.get(name)?.count ?? 0;
    if (actual !== expected) {
      fail(
        stepId,
        `created table ${name} holds ${actual} rows, expected ${expected}`,
      );
    }
  }

  for (const [name, tempName] of baseline.rowids.temp) {
    const table = after.tables.get(name);
    if (table === undefined || table.keyColumns === null) continue;
    const row = sqlite
      .prepare(
        `SELECT count(*) AS n FROM temp.${tempName} b JOIN (SELECT ${keyJson(table)} AS k, rowid AS r FROM main.${quote(name)} WHERE ${keyNotNull(table)}) a ON a.k = b.k WHERE a.r <> b.r`,
      )
      .get() as { n: number };
    if (row.n > 0) {
      fail(stepId, `table ${name} has ${row.n} rows whose rowid changed`);
    }
  }

  if (baseline.drift.temp !== null && after.tables.has(FTS_TABLE)) {
    const row = sqlite
      .prepare(
        `SELECT count(*) AS n FROM (${driftSql()} EXCEPT SELECT side, id, text FROM temp.${baseline.drift.temp})`,
      )
      .get() as { n: number };
    if (row.n > 0) {
      fail(
        stepId,
        `${row.n} search segments and full-text rows disagree after the step`,
      );
    }
  }

  for (const [name, beforeSeq] of before.counters) {
    const target = declared.tableRenames[name] ?? name;
    if (!after.tables.has(target) || !before.tables.has(name)) continue;
    if (!inScope(target)) continue;
    const afterSeq = after.counters.get(target) ?? 0;
    if (afterSeq < beforeSeq) {
      fail(
        stepId,
        `autoincrement counter of ${target} fell from ${beforeSeq} to ${afterSeq}`,
      );
    }
  }
  for (const [name, rows] of after.counterRows) {
    if (rows > 1 && inScope(name)) {
      fail(stepId, `sqlite_sequence has ${rows} rows for ${name}`);
    }
  }

  for (const entry of declared.copiedTables) {
    const table = after.tables.get(entry.table);
    const beforeDigest = baseline.preserved.digests.get(entry.table);
    if (table === undefined || beforeDigest === undefined) continue;
    const renamed = entry.preservedColumns.map(
      (column) => entry.columnRenames[column] ?? column,
    );
    const measured = measureTable(sqlite, table, {
      includeRowid: false,
      columns: preservedWithKey(table, renamed),
    });
    if (
      measured.digest !== beforeDigest ||
      measured.count !== baseline.preserved.counts.get(entry.table)
    ) {
      fail(stepId, `table ${entry.table} lost or changed preserved data`);
    }
  }
}

export function disposeStepBaseline(
  sqlite: Database.Database,
  baseline: StepBaseline,
): void {
  dropRowidBaseline(sqlite, baseline.rowids);
  if (baseline.drift.temp !== null) {
    sqlite.exec(`DROP TABLE IF EXISTS temp.${baseline.drift.temp}`);
  }
}

export interface ForeignKeyIdentityCapture {
  table: string;
}

interface ForeignKeyRow {
  id: number;
  seq: number;
  table: string;
  from: string;
  to: string | null;
}

let fkCounter = 0;

export function captureForeignKeyIdentities(
  sqlite: Database.Database,
  checks: StepChecks | null = null,
): ForeignKeyIdentityCapture {
  const renames = checks ?? EMPTY_STEP_CHECKS;
  fkCounter += 1;
  const name = `bb_chk_fk_${fkCounter}`;
  sqlite.exec(
    `CREATE TEMP TABLE ${name} (child TEXT NOT NULL, childKey TEXT NOT NULL, parent TEXT NOT NULL, columns TEXT NOT NULL, vals TEXT NOT NULL, n INTEGER NOT NULL)`,
  );
  for (const child of listUserTables(sqlite)) {
    if (child.virtual) continue;
    const foreignKeys = sqlite
      .prepare(
        'SELECT id, seq, "table", "from", "to" FROM pragma_foreign_key_list(?) ORDER BY id, seq',
      )
      .all(child.name) as ForeignKeyRow[];
    const byId = new Map<number, ForeignKeyRow[]>();
    for (const row of foreignKeys) {
      byId.set(row.id, [...(byId.get(row.id) ?? []), row]);
    }
    for (const group of byId.values()) {
      const parentName = group[0]?.table;
      if (parentName === undefined) continue;
      const parentColumns = group.map((row) =>
        row.to !== null ? row.to : primaryKeyOf(sqlite, parentName)[row.seq],
      );
      if (parentColumns.some((column) => column === undefined)) continue;
      const childColumns = group.map((row) => row.from);
      const nonNull = childColumns
        .map((column) => `c.${quote(column)} IS NOT NULL`)
        .join(" AND ");
      const match = childColumns
        .map(
          (column, index) =>
            `p.${quote(parentColumns[index] as string)} = c.${quote(column)}`,
        )
        .join(" AND ");
      const keyColumns = child.keyColumns ?? [];
      const childKeyExpr =
        keyColumns.length === 0
          ? "''"
          : `json_array(${keyColumns.map((key) => `c.${quote(key)}`).join(", ")})`;
      const values = `json_array(${childColumns.map((column) => `c.${quote(column)}`).join(", ")})`;
      const mappedChild = renames.tableRenames[child.name] ?? child.name;
      const mappedColumns = childColumns.map(
        (column) => renames.columnRenames[child.name]?.[column] ?? column,
      );
      sqlite
        .prepare(
          `INSERT INTO temp.${name} SELECT ?, ${childKeyExpr}, ?, ?, ${values}, count(*) FROM main.${quote(child.name)} c WHERE ${nonNull} AND NOT EXISTS (SELECT 1 FROM main.${quote(parentName)} p WHERE ${match}) GROUP BY ${childKeyExpr}, ${values}`,
        )
        .run(
          mappedChild,
          renames.tableRenames[parentName] ?? parentName,
          JSON.stringify(mappedColumns),
        );
    }
  }
  return { table: name };
}

function primaryKeyOf(sqlite: Database.Database, table: string): string[] {
  return (
    sqlite
      .prepare("SELECT name FROM pragma_table_info(?) WHERE pk > 0 ORDER BY pk")
      .all(table) as Array<{ name: string }>
  ).map((row) => row.name);
}

export function newForeignKeyIdentities(
  sqlite: Database.Database,
  before: ForeignKeyIdentityCapture,
  after: ForeignKeyIdentityCapture,
): number {
  const row = sqlite
    .prepare(
      `SELECT count(*) AS n FROM (SELECT child, childKey, parent, columns, vals, n FROM temp.${after.table} EXCEPT SELECT child, childKey, parent, columns, vals, n FROM temp.${before.table})`,
    )
    .get() as { n: number };
  return row.n;
}

export function disposeForeignKeyCapture(
  sqlite: Database.Database,
  capture: ForeignKeyIdentityCapture,
): void {
  sqlite.exec(`DROP TABLE IF EXISTS temp.${capture.table}`);
}
