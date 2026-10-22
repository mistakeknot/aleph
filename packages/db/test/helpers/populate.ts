import type Database from "better-sqlite3";

interface ColumnInfo {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function enumChoices(tableSql: string, column: string): string[] {
  const escaped = column.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `["\`]?${escaped}["\`]?\\s+in\\s*\\(([^)]*)\\)`,
    "gi",
  );
  const choices: string[] = [];
  for (const match of tableSql.matchAll(pattern)) {
    for (const literal of (match[1] ?? "").matchAll(/'((?:[^']|'')*)'/g))
      choices.push((literal[1] ?? "").replaceAll("''", "'"));
  }
  return choices;
}

type RowOverride = (row: number) => Record<string, unknown>;

const queuedMessageStates: Array<Record<string, unknown>> = [
  { state: "queued", group_with_next: 0 },
  {
    state: "scheduled",
    group_with_next: 1,
    send_at: 1000,
    waiting_on: '{"kind":"time"}',
  },
  {
    state: "waiting",
    group_with_next: 0,
    waiting_on: '{"kind":"plugin","pluginId":"p"}',
    wait_holder: "plugin:p",
  },
];

const rowOverrides: Record<string, RowOverride> = {
  project_sources: () => ({ type: "local_path" }),
  events: () => ({ scope_kind: "turn" }),
  queued_thread_messages: (row) => ({
    forward_source_row_id: null,
    claimed_at: null,
    claim_token: null,
    failure_reason: null,
    failure_count: 0,
    next_attempt_at: null,
    send_at: null,
    waiting_on: null,
    wait_holder: null,
    ...queuedMessageStates[row % queuedMessageStates.length],
  }),
};

function candidateValue(
  table: string,
  column: ColumnInfo,
  row: number,
  choices: string[],
): unknown {
  const type = column.type.toUpperCase();
  if (choices.length > 0) return choices[row % choices.length];
  if (type.includes("INT") && column.pk > 0) return row + 1000;
  if (type.includes("INT") || type === "BOOLEAN") return row + 1;
  if (type.includes("REAL") || type.includes("FLOA") || type.includes("DOUB"))
    return row + 0.5;
  if (type.includes("BLOB"))
    return Buffer.from(`${table}.${column.name}.${row}`);
  return `${table}.${column.name}.${row}`;
}

export interface PopulateOptions {
  rowsPerTable?: number;
  tables?: readonly string[];
}

export interface PopulateResult {
  inserted: Record<string, number>;
  failed: Record<string, string>;
}

export function populateDatabase(
  sqlite: Database.Database,
  options: PopulateOptions = {},
): PopulateResult {
  const rowsPerTable = options.rowsPerTable ?? 3;
  const tables = (
    sqlite
      .prepare(
        "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name <> '__drizzle_migrations' AND sql NOT LIKE 'CREATE VIRTUAL TABLE%' AND name NOT IN (SELECT name FROM pragma_table_list WHERE type = 'shadow') ORDER BY name",
      )
      .all() as Array<{ name: string; sql: string }>
  ).filter(({ name }) => !options.tables || options.tables.includes(name));
  const inserted: Record<string, number> = {};
  const failed: Record<string, string> = {};
  sqlite.pragma("foreign_keys = OFF");
  for (const { name, sql } of tables) {
    const columns = (
      sqlite
        .prepare("SELECT * FROM pragma_table_xinfo(?) WHERE hidden = 0")
        .all(name) as ColumnInfo[]
    ).filter((column) => column.name !== "rowid");
    const columnList = columns.map((c) => quoteIdentifier(c.name)).join(", ");
    const placeholders = columns.map(() => "?").join(", ");
    const statement = sqlite.prepare(
      `INSERT INTO ${quoteIdentifier(name)} (${columnList}) VALUES (${placeholders})`,
    );
    inserted[name] = 0;
    for (let row = 0; row < rowsPerTable; row += 1) {
      const base: Record<string, unknown> = {};
      for (const column of columns)
        base[column.name] = candidateValue(
          name,
          column,
          row,
          enumChoices(sql, column.name),
        );
      const merged = { ...base, ...rowOverrides[name]?.(row) };
      if (name === "thread_pruning_cursors") merged.scope = merged.thread_id;
      const values = columns.map((column) => merged[column.name]);
      try {
        statement.run(...values);
        inserted[name] += 1;
      } catch (error) {
        failed[name] = (error as Error).message;
        break;
      }
    }
  }
  return { inserted, failed };
}
