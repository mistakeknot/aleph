import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { rowidAlias } from "./migration-backup.js";
import {
  splitMigrationStatements,
  statementIdentifiers,
} from "./migration-guard.js";
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
  normalizedColumns: Readonly<Record<string, string>>;
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
  rowDeltas: nullMap(),
  renumbersRowids: [],
  tableRenames: nullMap(),
  columnRenames: nullMap(),
};

function nullMap<T>(entries: Iterable<[string, T]> = []): Record<string, T> {
  const map: Record<string, T> = Object.create(null) as Record<string, T>;
  for (const [key, value] of entries) map[key] = value;
  return map;
}

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
  if (value === undefined) return nullMap();
  if (!isRecord(value)) throw new Error(`Step checks ${label} must be a map`);
  const out = nullMap<string>();
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
  const rowDeltas = nullMap<number>();
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
  const columnRenames = nullMap<Record<string, string>>();
  if (raw.columnRenames !== undefined) {
    if (!isRecord(raw.columnRenames)) {
      throw new Error(`Step checks for ${id} columnRenames must be a map`);
    }
    for (const [table, map] of Object.entries(raw.columnRenames)) {
      if (Object.hasOwn(columnRenames, fold(table))) {
        throw new Error(
          `Step checks for ${id} declare columnRenames for ${table} twice, differing only by case`,
        );
      }
      columnRenames[fold(table)] = foldKeys(
        stringMap(map, `columnRenames.${table}`),
      );
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
        columnRenames: foldKeys(
          stringMap(entry.columnRenames, "columnRenames"),
        ),
        normalizedColumns: stringMap(
          entry.normalizedColumns,
          "normalizedColumns",
        ),
      };
    }),
    rowDeltas,
    renumbersRowids: stringList(raw.renumbersRowids, "renumbersRowids"),
    tableRenames: foldKeys(stringMap(raw.tableRenames, "tableRenames")),
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
  withoutRowid: boolean;
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
  counters: Map<string, bigint>;
  counterRows: Map<string, number>;
  triggerWrites: Map<string, Set<string>>;
}

function fold(name: string): string {
  return name.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

function foldKeys(map: Record<string, string>): Record<string, string> {
  const folded = nullMap<string>();
  for (const [key, value] of Object.entries(map)) {
    if (Object.hasOwn(folded, fold(key))) {
      throw new Error(
        `Step checks declare ${key} twice, differing only by case`,
      );
    }
    folded[fold(key)] = value;
  }
  return folded;
}

function renamedColumn(
  map: Readonly<Record<string, string>> | undefined,
  column: string,
): string {
  return map?.[fold(column)] ?? column;
}

function storedColumn(table: UserTable, name: string): string {
  const folded = fold(name);
  return (
    table.columns.find((column) => fold(column.name) === folded)?.name ?? name
  );
}

function tableByName<T>(
  tables: ReadonlyMap<string, T>,
  name: string,
): T | undefined {
  const exact = tables.get(name);
  if (exact !== undefined) return exact;
  const folded = fold(name);
  for (const [candidate, value] of tables) {
    if (fold(candidate) === folded) return value;
  }
  return undefined;
}

function quote(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function listUserTables(sqlite: Database.Database): UserTable[] {
  const rows = sqlite
    .prepare(
      "SELECT name, type, wr FROM pragma_table_list WHERE schema = 'main' AND type IN ('table', 'virtual') AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name",
    )
    .all() as Array<{ name: string; type: string; wr: number }>;
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
    tables.push({
      name: row.name,
      virtual,
      withoutRowid: row.wr === 1,
      columns,
      keyColumns,
      nullableKey,
    });
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

function rowidAliasOf(sqlite: Database.Database, table: string): string {
  const alias = rowidAlias(sqlite, "main", table);
  if (alias === null) {
    throw new Error(
      `Table ${table} shadows every rowid name; its rowids cannot be read`,
    );
  }
  return alias;
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
  const withRowid = options.includeRowid && !table.withoutRowid;
  const alias = withRowid ? rowidAliasOf(sqlite, table.name) : "";
  const statement = sqlite
    .prepare(
      withRowid
        ? `SELECT ${alias}, ${selected} FROM ${quote(table.name)}`
        : `SELECT ${selected} FROM ${quote(table.name)}`,
    )
    .raw()
    .safeIntegers(true);
  let count = 0;
  let digest = 0n;
  for (const row of statement.iterate() as IterableIterator<unknown[]>) {
    const parts: Array<{ type: string; value: unknown }> = [];
    let offset = 0;
    if (withRowid) {
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
    const written = graph.get(fold(row.tableName)) ?? new Set<string>();
    for (const match of body.matchAll(TRIGGER_WRITE)) {
      const target = match[1];
      if (target !== undefined) written.add(fold(target));
    }
    graph.set(fold(row.tableName), written);
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
  counters: Map<string, bigint>;
  rows: Map<string, number>;
} {
  const counters = new Map<string, bigint>();
  const rows = new Map<string, number>();
  const exists = sqlite
    .prepare("SELECT 1 FROM sqlite_master WHERE name = 'sqlite_sequence'")
    .get();
  if (exists === undefined) return { counters, rows };
  for (const row of sqlite
    .prepare("SELECT name, seq FROM sqlite_sequence")
    .safeIntegers(true)
    .all() as Array<{ name: string; seq: bigint }>) {
    const known = counters.get(row.name) ?? 0n;
    counters.set(row.name, row.seq > known ? row.seq : known);
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
    if (
      table.virtual ||
      table.withoutRowid ||
      table.keyColumns === null ||
      skip(table.name)
    )
      continue;
    baselineCounter += 1;
    const name = `bb_chk_rowids_${baselineCounter}`;
    sqlite.exec(
      `CREATE TEMP TABLE ${name} AS SELECT ${keyJson(table)} AS k, ${rowidAliasOf(sqlite, table.name)} AS r FROM main.${quote(table.name)} WHERE ${keyNotNull(table)}`,
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
  stepId: string,
): PreservedBaseline {
  const digests = new Map<string, bigint>();
  const counts = new Map<string, number>();
  for (const copied of checks.copiedTables) {
    const table = tableByName(snapshot.tables, copied.table);
    if (table === undefined) {
      fail(
        stepId,
        `declared table ${copied.table} does not exist before the step`,
      );
    }
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
  return [
    ...new Set([
      ...(table.keyColumns ?? []),
      ...preserved.map((column) => storedColumn(table, column)),
    ]),
  ];
}

interface TempColumns {
  temp: string;
  columns: string[];
}

export interface StepBaseline {
  snapshot: StepSnapshot;
  rowids: RowidBaseline;
  drift: DriftCapture;
  preserved: PreservedBaseline;
  nullKeys: Map<string, TempColumns>;
  normalized: Map<string, TempColumns>;
}

export function namedTables(sql: string): Set<string> {
  const names = new Set<string>();
  for (const statement of splitMigrationStatements(sql)) {
    for (const name of statementIdentifiers(statement)) names.add(fold(name));
  }
  return names;
}

function excusedTables(
  checks: StepChecks | null,
  guarded: ReadonlySet<string> | null,
  named: ReadonlySet<string> | null,
  graph: ReadonlyMap<string, ReadonlySet<string>>,
): Set<string> {
  if (checks !== null || guarded === null || named === null) {
    return new Set();
  }
  const excused = new Set([...named, ...triggerClosure(graph, named)]);
  for (const table of guarded) excused.delete(table);
  return excused;
}

function mergeGraphs(
  first: ReadonlyMap<string, ReadonlySet<string>>,
  second: ReadonlyMap<string, ReadonlySet<string>>,
): Map<string, Set<string>> {
  const merged = new Map<string, Set<string>>();
  for (const graph of [first, second]) {
    for (const [table, targets] of graph) {
      const known = merged.get(table) ?? new Set<string>();
      for (const target of targets) known.add(target);
      merged.set(table, known);
    }
  }
  return merged;
}

function captureNullKeyGroups(
  sqlite: Database.Database,
  snapshot: StepSnapshot,
  skip: (table: string) => boolean,
): Map<string, TempColumns> {
  const captured = new Map<string, TempColumns>();
  for (const table of snapshot.tables.values()) {
    if (table.virtual || !table.nullableKey || skip(table.name)) continue;
    const missing = `NOT (${keyNotNull(table)})`;
    const present = sqlite
      .prepare(
        `SELECT 1 AS present FROM main.${quote(table.name)} WHERE ${missing} LIMIT 1`,
      )
      .get();
    if (present === undefined) continue;
    const columns = table.columns.map((column) => column.name);
    const aliased = columns.map(
      (column, index) => `${quote(column)} AS c${index}`,
    );
    const grouped = columns.map((_, index) => `c${index}`).join(", ");
    baselineCounter += 1;
    const name = `bb_chk_nullkeys_${baselineCounter}`;
    sqlite.exec(
      `CREATE TEMP TABLE ${name} AS SELECT ${aliased.join(", ")}, count(*) AS n FROM main.${quote(table.name)} WHERE ${missing} GROUP BY ${grouped}`,
    );
    captured.set(table.name, { temp: name, columns });
  }
  return captured;
}

function captureNormalized(
  sqlite: Database.Database,
  snapshot: StepSnapshot,
  checks: StepChecks,
): Map<string, TempColumns> {
  const captured = new Map<string, TempColumns>();
  for (const entry of checks.copiedTables) {
    const table = tableByName(snapshot.tables, entry.table);
    const columns = Object.keys(entry.normalizedColumns);
    if (table === undefined || columns.length === 0) continue;
    const projected = columns.flatMap((column, index) => [
      `(${entry.normalizedColumns[column]}) AS e${index}`,
      `typeof(${entry.normalizedColumns[column]}) AS t${index}`,
    ]);
    baselineCounter += 1;
    const name = `bb_chk_norm_${baselineCounter}`;
    sqlite.exec(
      `CREATE TEMP TABLE ${name} AS SELECT ${keyJson(table)} AS k, ${projected.join(", ")} FROM main.${quote(table.name)} AS o WHERE ${keyNotNull(table)}`,
    );
    captured.set(entry.table, { temp: name, columns });
  }
  return captured;
}

export function captureStepBaseline(
  sqlite: Database.Database,
  stepId: string,
  checks: StepChecks | null,
  guarded: ReadonlySet<string> | null,
  named: ReadonlySet<string> | null,
): StepBaseline {
  const declared = checks ?? EMPTY_STEP_CHECKS;
  const renumbers = new Set(declared.renumbersRowids.map(fold));
  const snapshot = captureStepSnapshot(
    sqlite,
    stepId,
    (table) => !renumbers.has(fold(table)),
  );
  const rowids = captureRowidBaseline(sqlite, snapshot, (table) =>
    renumbers.has(fold(table)),
  );
  const writes = new Set(declared.writesTables.map(fold));
  return {
    snapshot,
    rowids,
    drift: captureFtsDrift(sqlite, snapshot),
    preserved: capturePreserved(sqlite, snapshot, declared, stepId),
    nullKeys: captureNullKeyGroups(sqlite, snapshot, (table) =>
      writes.has(fold(table)),
    ),
    normalized: captureNormalized(sqlite, snapshot, declared),
  };
}

function fail(stepId: string, message: string): never {
  throw new MigrationStepCheckError(stepId, message);
}

function verifyNormalized(
  sqlite: Database.Database,
  stepId: string,
  entry: CopiedTableDeclaration,
  captured: TempColumns,
  table: UserTable,
): void {
  const pairs = captured.columns.map((column, index) => ({
    column: storedColumn(table, renamedColumn(entry.columnRenames, column)),
    index,
  }));
  for (const { column } of pairs) {
    if (!table.columns.some((candidate) => candidate.name === column)) {
      fail(stepId, `table ${table.name} lost normalized column ${column}`);
    }
  }
  const mismatch = pairs
    .map(
      ({ column, index }) =>
        `a.${quote(column)} IS NOT b.e${index} OR typeof(a.${quote(column)}) <> b.t${index}`,
    )
    .join(" OR ");
  const selected = pairs.map(({ column }) => quote(column)).join(", ");
  const row = sqlite
    .prepare(
      `SELECT count(*) AS n FROM temp.${captured.temp} b JOIN (SELECT ${keyJson(table)} AS k, ${selected} FROM main.${quote(table.name)} WHERE ${keyNotNull(table)}) a ON a.k = b.k WHERE ${mismatch}`,
    )
    .get() as { n: number };
  if (row.n > 0) {
    fail(
      stepId,
      `table ${table.name} has ${row.n} rows whose normalized columns differ from the declared expressions`,
    );
  }
}

function verifyNullKeyGroups(
  sqlite: Database.Database,
  stepId: string,
  captured: TempColumns,
  table: UserTable,
  columnFor: (column: string) => string | null,
): void {
  const kept = captured.columns
    .map((column, index) => ({ target: columnFor(column), index }))
    .filter(
      (pair): pair is { target: string; index: number } =>
        pair.target !== null &&
        table.columns.some(
          (column) => fold(column.name) === fold(pair.target as string),
        ),
    );
  if (kept.length === 0) return;
  const beforeColumns = kept.map(({ index }) => `c${index}`).join(", ");
  const afterColumns = kept
    .map(
      ({ target }, position) =>
        `${quote(storedColumn(table, target))} AS x${position}`,
    )
    .join(", ");
  const afterGroup = kept.map((_, position) => `x${position}`).join(", ");
  const match = kept
    .map(({ index }, position) => `a.x${position} IS b.c${index}`)
    .join(" AND ");
  const row = sqlite
    .prepare(
      `SELECT count(*) AS n FROM (SELECT ${beforeColumns}, sum(n) AS n FROM temp.${captured.temp} GROUP BY ${beforeColumns}) b WHERE NOT EXISTS (SELECT 1 FROM (SELECT ${afterColumns}, count(*) AS n FROM main.${quote(table.name)} GROUP BY ${afterGroup}) a WHERE ${match} AND a.n >= b.n)`,
    )
    .get() as { n: number };
  if (row.n > 0) {
    fail(
      stepId,
      `table ${table.name} lost or changed ${row.n} row groups that have no key value`,
    );
  }
}

export function verifyStep(
  sqlite: Database.Database,
  stepId: string,
  checks: StepChecks | null,
  guarded: ReadonlySet<string> | null,
  named: ReadonlySet<string> | null,
  baseline: StepBaseline,
): void {
  const declared = checks ?? EMPTY_STEP_CHECKS;
  const renumbers = new Set(declared.renumbersRowids.map(fold));
  const after = captureStepSnapshot(
    sqlite,
    stepId,
    (table) => !renumbers.has(fold(table)),
  );
  const before = baseline.snapshot;
  const graph = mergeGraphs(before.triggerWrites, after.triggerWrites);
  const excused = excusedTables(checks, guarded, named, graph);
  const implicit = checks === null && guarded !== null;
  const mayCreateUndeclared = (table: string): boolean =>
    excused.has(fold(table));

  const hasAfter = (name: string): boolean =>
    tableByName(after.tables, name) !== undefined;
  const deltas = new Map(
    Object.entries(declared.rowDeltas).map(([name, delta]) => [
      fold(name),
      delta,
    ]),
  );
  const tableColumnRenames = new Map(
    Object.entries(declared.columnRenames).map(([name, map]) => [
      fold(name),
      map,
    ]),
  );
  const columnRenameFor = (name: string, column: string): string | undefined =>
    tableColumnRenames.get(fold(name))?.[fold(column)];
  const renames = new Map(
    Object.entries(declared.tableRenames).map(([from, to]) => [fold(from), to]),
  );
  const storedName = (name: string): string | undefined => {
    const table = tableByName(after.tables, name);
    return table === undefined ? undefined : table.name;
  };
  const resolve = (name: string): string => {
    const direct = storedName(name);
    if (direct !== undefined) return direct;
    const renamed = renames.get(fold(name));
    if (renamed === undefined) return name;
    return storedName(renamed) ?? renamed;
  };
  const renameTargets = new Set<string>();
  for (const name of before.tables.keys()) {
    const target = resolve(name);
    if (target !== name && hasAfter(target)) {
      renameTargets.add(fold(target));
    }
  }

  const creates = new Set(declared.createsTables.map(fold));
  const drops = new Set(declared.dropsTables.map(fold));
  const writes = new Set(declared.writesTables.map(fold));
  const copied = new Map(
    declared.copiedTables.map((entry) => [fold(entry.table), entry]),
  );
  const directWrites = new Set([
    ...writes,
    ...copied.keys(),
    ...creates,
    ...drops,
  ]);
  const triggerTargets = triggerClosure(graph, [...writes, ...copied.keys()]);
  const afterByFold = new Set([...after.tables.keys()].map(fold));
  for (const target of triggerTargets) {
    if (
      afterByFold.has(target) &&
      !directWrites.has(target) &&
      writes.size + copied.size > 0 &&
      !implicit
    ) {
      fail(
        stepId,
        `table ${target} is written by triggers of a declared table but is not declared in writesTables`,
      );
    }
  }
  for (const name of before.tables.keys()) {
    if (hasAfter(name)) continue;
    const target = resolve(name);
    if (target !== name && hasAfter(target)) continue;
    if (!drops.has(fold(name))) {
      fail(stepId, `table ${name} was dropped without being declared`);
    }
  }
  for (const name of after.tables.keys()) {
    if (before.tables.has(name)) continue;
    if (
      !creates.has(fold(name)) &&
      !renameTargets.has(fold(name)) &&
      !mayCreateUndeclared(name)
    ) {
      fail(stepId, `table ${name} was created without being declared`);
    }
  }
  for (const name of declared.dropsTables) {
    if (hasAfter(name)) {
      fail(stepId, `table ${name} is declared dropped but still exists`);
    }
  }

  for (const [name, beforeMeasure] of before.measures) {
    const target = resolve(name);
    const afterMeasure = after.measures.get(target);
    if (afterMeasure === undefined) continue;
    const delta = deltas.get(fold(name)) ?? 0;
    if (afterMeasure.count - beforeMeasure.count !== delta) {
      fail(
        stepId,
        `table ${name} row count changed from ${beforeMeasure.count} to ${afterMeasure.count}, expected a change of ${delta}`,
      );
    }
    if (!directWrites.has(fold(name)) && !triggerTargets.has(fold(name))) {
      if (afterMeasure.digest !== beforeMeasure.digest) {
        fail(
          stepId,
          `table ${name} content changed but the step does not declare it`,
        );
      }
    }
  }
  for (const name of declared.createsTables) {
    const table = tableByName(after.tables, name);
    if (table === undefined) {
      fail(stepId, `table ${name} is declared created but does not exist`);
    }
    const expected = deltas.get(fold(name)) ?? 0;
    const actual = tableByName(after.measures, name)?.count ?? 0;
    if (actual !== expected) {
      fail(
        stepId,
        `created table ${name} holds ${actual} rows, expected ${expected}`,
      );
    }
  }

  for (const [name, tempName] of baseline.rowids.temp) {
    const table = after.tables.get(resolve(name));
    if (
      table === undefined ||
      table.keyColumns === null ||
      table.withoutRowid
    ) {
      continue;
    }
    const row = sqlite
      .prepare(
        `SELECT count(*) AS n FROM temp.${tempName} b JOIN (SELECT ${keyJson(table)} AS k, ${rowidAliasOf(sqlite, table.name)} AS r FROM main.${quote(table.name)} WHERE ${keyNotNull(table)}) a ON a.k = b.k WHERE a.r <> b.r`,
      )
      .get() as { n: number };
    if (row.n > 0) {
      fail(stepId, `table ${name} has ${row.n} rows whose rowid changed`);
    }
  }

  for (const [name, captured] of baseline.nullKeys) {
    const table = after.tables.get(resolve(name));
    if (table === undefined || writes.has(fold(name))) {
      continue;
    }
    const entry = copied.get(fold(name));
    const preserved =
      entry === undefined ? null : new Set(entry.preservedColumns.map(fold));
    verifyNullKeyGroups(sqlite, stepId, captured, table, (column) => {
      if (preserved !== null && !preserved.has(fold(column))) return null;
      return (
        (entry === undefined
          ? undefined
          : renamedColumn(entry.columnRenames, column)) ??
        columnRenameFor(name, column) ??
        column
      );
    });
  }

  if (baseline.drift.temp !== null && hasAfter(FTS_TABLE)) {
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
    const target = resolve(name);
    if (!hasAfter(target) || !before.tables.has(name)) continue;
    const afterSeq = tableByName(after.counters, target) ?? 0n;
    if (afterSeq < beforeSeq) {
      fail(
        stepId,
        `autoincrement counter of ${target} fell from ${beforeSeq} to ${afterSeq}`,
      );
    }
  }
  for (const [name, rows] of after.counterRows) {
    if (rows > 1) {
      fail(stepId, `sqlite_sequence has ${rows} rows for ${name}`);
    }
  }

  for (const entry of declared.copiedTables) {
    const beforeDigest = baseline.preserved.digests.get(entry.table);
    if (beforeDigest === undefined) continue;
    const table = tableByName(after.tables, resolve(entry.table));
    if (table === undefined) {
      fail(stepId, `table ${entry.table} is missing after the step`);
    }
    const renamed = entry.preservedColumns.map((column) =>
      renamedColumn(entry.columnRenames, column),
    );
    const columns = preservedWithKey(table, renamed);
    for (const column of columns) {
      if (!table.columns.some((candidate) => candidate.name === column)) {
        fail(stepId, `table ${entry.table} lost preserved column ${column}`);
      }
    }
    const measured = measureTable(sqlite, table, {
      includeRowid: false,
      columns,
    });
    if (
      measured.digest !== beforeDigest ||
      measured.count !== baseline.preserved.counts.get(entry.table)
    ) {
      fail(stepId, `table ${entry.table} lost or changed preserved data`);
    }
    const normalized = baseline.normalized.get(entry.table);
    if (normalized !== undefined) {
      verifyNormalized(sqlite, stepId, entry, normalized, table);
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
  for (const captured of [
    ...baseline.nullKeys.values(),
    ...baseline.normalized.values(),
  ]) {
    sqlite.exec(`DROP TABLE IF EXISTS temp.${captured.temp}`);
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
      const mappedChild = renames.tableRenames[fold(child.name)] ?? child.name;
      const mappedColumns = childColumns.map((column) =>
        fold(renamedColumn(renames.columnRenames[fold(child.name)], column)),
      );
      sqlite
        .prepare(
          `INSERT INTO temp.${name} SELECT ?, ${childKeyExpr}, ?, ?, ${values}, count(*) FROM main.${quote(child.name)} c WHERE ${nonNull} AND NOT EXISTS (SELECT 1 FROM main.${quote(parentName)} p WHERE ${match}) GROUP BY ${childKeyExpr}, ${values}`,
        )
        .run(
          fold(mappedChild),
          fold(renames.tableRenames[fold(parentName)] ?? parentName),
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
      `SELECT count(*) AS n FROM temp.${after.table} a LEFT JOIN temp.${before.table} b ON a.child = b.child AND a.childKey IS b.childKey AND a.parent = b.parent AND a.columns = b.columns AND a.vals IS b.vals WHERE a.n > COALESCE(b.n, 0)`,
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
