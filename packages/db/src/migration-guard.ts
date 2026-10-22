import type Database from "better-sqlite3";
import type {
  FrozenUpstreamStep,
  MigrationPlan,
  MigrationPlanInput,
} from "./migration-plan.js";

export class MigrationGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrationGuardError";
  }
}

const STATEMENT_BREAKPOINT = "--> statement-breakpoint";

export function splitMigrationStatements(sql: string): string[] {
  return sql
    .split(STATEMENT_BREAKPOINT)
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

type TokenKind = "word" | "quoted" | "string" | "punct";

interface Token {
  kind: TokenKind;
  value: string;
}

const WORD_CHARACTER = /[\w$\u0080-\uffff]/;
const NEW_TABLE_PREFIX = "__new_";

function readQuoted(
  sql: string,
  start: number,
): { value: string; next: number } {
  const quote = sql.charAt(start);
  let value = "";
  let index = start + 1;
  while (index < sql.length) {
    if (sql.charAt(index) === quote) {
      if (sql.charAt(index + 1) === quote) {
        value += quote;
        index += 2;
        continue;
      }
      return { value, next: index + 1 };
    }
    value += sql.charAt(index);
    index += 1;
  }
  return { value, next: index };
}

function tokenize(sql: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < sql.length) {
    const character = sql.charAt(index);
    if (/\s/.test(character)) {
      index += 1;
    } else if (character === "-" && sql.charAt(index + 1) === "-") {
      const end = sql.indexOf("\n", index);
      index = end === -1 ? sql.length : end + 1;
    } else if (character === "/" && sql.charAt(index + 1) === "*") {
      const end = sql.indexOf("*/", index + 2);
      index = end === -1 ? sql.length : end + 2;
    } else if (character === '"' || character === "`" || character === "'") {
      const quoted = readQuoted(sql, index);
      tokens.push({
        kind: character === "'" ? "string" : "quoted",
        value: quoted.value,
      });
      index = quoted.next;
    } else if (character === "[") {
      const end = sql.indexOf("]", index + 1);
      const close = end === -1 ? sql.length : end;
      tokens.push({ kind: "quoted", value: sql.slice(index + 1, close) });
      index = end === -1 ? sql.length : end + 1;
    } else if (WORD_CHARACTER.test(character)) {
      let end = index + 1;
      while (end < sql.length && WORD_CHARACTER.test(sql.charAt(end))) end += 1;
      tokens.push({ kind: "word", value: sql.slice(index, end) });
      index = end;
    } else {
      tokens.push({ kind: "punct", value: character });
      index += 1;
    }
  }
  return tokens;
}

function isName(token: Token | undefined): token is Token {
  return token !== undefined && token.kind !== "punct";
}

function isKeyword(token: Token | undefined, keyword: string): boolean {
  return (
    token !== undefined &&
    token.kind === "word" &&
    token.value.toUpperCase() === keyword
  );
}

interface TableReference {
  name: string;
  schema: string | undefined;
  next: number;
}

function readTableName(
  tokens: readonly Token[],
  index: number,
): TableReference | undefined {
  const first = tokens[index];
  if (!isName(first)) return undefined;
  const dot = tokens[index + 1];
  const qualified = tokens[index + 2];
  if (dot?.kind === "punct" && dot.value === "." && isName(qualified)) {
    return { name: qualified.value, schema: first.value, next: index + 3 };
  }
  return { name: first.value, schema: undefined, next: index + 1 };
}

function normalizeTableName(name: string): string {
  const folded = name.toLowerCase();
  return folded.startsWith(NEW_TABLE_PREFIX)
    ? folded.slice(NEW_TABLE_PREFIX.length)
    : folded;
}

export function scanRebuiltTables(sql: string): string[] {
  const tokens = tokenize(sql);
  const rebuilt = new Set<string>();
  const add = (table: TableReference | undefined) => {
    if (table === undefined || table.name.length === 0) return;
    if (table.schema?.toLowerCase() === "temp") return;
    rebuilt.add(normalizeTableName(table.name));
  };
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (isKeyword(token, "DROP") && isKeyword(tokens[index + 1], "TABLE")) {
      let cursor = index + 2;
      if (
        isKeyword(tokens[cursor], "IF") &&
        isKeyword(tokens[cursor + 1], "EXISTS")
      ) {
        cursor += 2;
      }
      add(readTableName(tokens, cursor));
    } else if (
      isKeyword(token, "ALTER") &&
      isKeyword(tokens[index + 1], "TABLE")
    ) {
      const table = readTableName(tokens, index + 2);
      add(table);
      if (
        table !== undefined &&
        isKeyword(tokens[table.next], "RENAME") &&
        isKeyword(tokens[table.next + 1], "TO")
      ) {
        const target = readTableName(tokens, table.next + 2);
        if (target !== undefined) {
          add({ ...target, schema: table.schema });
        }
      }
    } else if (isKeyword(token, "CREATE")) {
      let cursor = index + 1;
      if (
        isKeyword(tokens[cursor], "TEMP") ||
        isKeyword(tokens[cursor], "TEMPORARY")
      ) {
        cursor += 1;
      }
      if (isKeyword(tokens[cursor], "VIRTUAL")) cursor += 1;
      if (!isKeyword(tokens[cursor], "TABLE")) continue;
      cursor += 1;
      if (
        isKeyword(tokens[cursor], "IF") &&
        isKeyword(tokens[cursor + 1], "NOT") &&
        isKeyword(tokens[cursor + 2], "EXISTS")
      ) {
        cursor += 3;
      }
      const created = readTableName(tokens, cursor);
      if (created?.name.toLowerCase().startsWith(NEW_TABLE_PREFIX)) {
        add(created);
      }
    }
  }
  return [...rebuilt].sort();
}

export function verifyFrozenSet(
  frozen: readonly FrozenUpstreamStep[],
  input: MigrationPlanInput,
): void {
  const frozenByTag = new Map(frozen.map((step) => [step.tag, step]));
  const upstreamByTag = new Map(input.upstream.map((step) => [step.tag, step]));
  for (const step of frozen) {
    const actual = upstreamByTag.get(step.tag);
    if (actual === undefined) {
      throw new MigrationGuardError(
        `Frozen upstream step ${step.tag} is missing from the upstream journal`,
      );
    }
    if (actual.sha256 !== step.sha256) {
      throw new MigrationGuardError(
        `Frozen upstream step ${step.tag} changed: expected sha256 ${step.sha256} but found ${actual.sha256}`,
      );
    }
  }
  for (const step of frozen) {
    if (step.supersededBy === undefined) continue;
    const replacement = input.aleph.find(
      (candidate) => candidate.id === step.supersededBy,
    );
    if (replacement?.supersedes !== step.tag) {
      throw new MigrationGuardError(
        `Frozen upstream step ${step.tag} is marked superseded by ${step.supersededBy}, which does not supersede it`,
      );
    }
  }
  for (const step of input.aleph) {
    if (step.supersedes === undefined) continue;
    if (frozenByTag.get(step.supersedes)?.supersededBy !== step.id) {
      throw new MigrationGuardError(
        `${step.id} supersedes ${step.supersedes}, which is not frozen as superseded by it`,
      );
    }
  }
}

export function nonFrozenUpstreamSteps(
  frozen: readonly FrozenUpstreamStep[],
  input: MigrationPlanInput,
): string[] {
  const frozenTags = new Set(frozen.map((step) => step.tag));
  return input.upstream
    .map((step) => step.tag)
    .filter((tag) => !frozenTags.has(tag));
}

interface SchemaObjectRow {
  type: string;
  name: string;
  tbl_name: string;
  sql: string | null;
}

function collapseWhitespace(sql: string | null): string {
  return (sql ?? "").replace(/\s+/g, " ").trim();
}

function readSchemaObjects(sqlite: Database.Database): SchemaObjectRow[] {
  return sqlite
    .prepare(
      "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name <> '__drizzle_migrations' ORDER BY name",
    )
    .all() as SchemaObjectRow[];
}

interface SchemaIndex {
  tables: ReadonlySet<string>;
  views: ReadonlyMap<string, SchemaObjectRow>;
}

function indexSchema(rows: readonly SchemaObjectRow[]): SchemaIndex {
  const tables = new Set<string>();
  const views = new Map<string, SchemaObjectRow>();
  for (const row of rows) {
    if (row.type === "table") tables.add(row.name.toLowerCase());
    if (row.type === "view") views.set(row.name.toLowerCase(), row);
  }
  return { tables, views };
}

function referencedNames(row: SchemaObjectRow, index: SchemaIndex): string[] {
  const names = new Set<string>();
  for (const token of tokenize(row.sql ?? "")) {
    if (token.kind !== "word" && token.kind !== "quoted") continue;
    const name = token.value.toLowerCase();
    if (index.tables.has(name) || index.views.has(name)) names.add(name);
  }
  return [...names];
}

function baseTables(
  name: string,
  index: SchemaIndex,
  visited: Set<string>,
  into: Set<string>,
): void {
  if (index.tables.has(name)) {
    into.add(name);
    return;
  }
  const view = index.views.get(name);
  if (view === undefined || visited.has(name)) return;
  visited.add(name);
  for (const reference of referencedNames(view, index)) {
    baseTables(reference, index, visited, into);
  }
}

function tablesTouchedBy(
  row: SchemaObjectRow,
  index: SchemaIndex,
): Set<string> {
  const touched = new Set<string>([row.tbl_name.toLowerCase()]);
  const visited = new Set<string>();
  baseTables(row.tbl_name.toLowerCase(), index, visited, touched);
  if (row.type !== "trigger" && row.type !== "view") return touched;
  for (const reference of referencedNames(row, index)) {
    baseTables(reference, index, visited, touched);
  }
  return touched;
}

function schemaByTable(sqlite: Database.Database): Map<string, string[]> {
  const rows = readSchemaObjects(sqlite);
  const index = indexSchema(rows);
  const byTable = new Map<string, string[]>();
  for (const row of rows) {
    for (const table of tablesTouchedBy(row, index)) {
      const lines = byTable.get(table) ?? [];
      lines.push(`${row.name}|${collapseWhitespace(row.sql)}`);
      byTable.set(table, lines);
    }
  }
  return byTable;
}

export function computeAlteredTables(
  upstreamOnly: Database.Database,
  withAleph: Database.Database,
): string[] {
  const before = schemaByTable(upstreamOnly);
  const after = schemaByTable(withAleph);
  const altered: string[] = [];
  for (const table of new Set([...before.keys(), ...after.keys()])) {
    if (
      JSON.stringify(before.get(table) ?? []) !==
      JSON.stringify(after.get(table) ?? [])
    ) {
      altered.push(table);
    }
  }
  return altered.sort();
}

export function expandWithForeignKeyNeighbours(
  sqlite: Database.Database,
  altered: readonly string[],
): string[] {
  const alteredSet = new Set(altered.map((table) => table.toLowerCase()));
  const edges = sqlite
    .prepare(
      "SELECT m.name AS child, f.\"table\" AS parent FROM sqlite_master m, pragma_foreign_key_list(m.name) f WHERE m.type = 'table'",
    )
    .all() as Array<{ child: string; parent: string }>;
  const guarded = new Set(alteredSet);
  for (const edge of edges) {
    const child = edge.child.toLowerCase();
    const parent = edge.parent.toLowerCase();
    if (alteredSet.has(child)) guarded.add(parent);
    if (alteredSet.has(parent)) guarded.add(child);
  }
  const rows = readSchemaObjects(sqlite);
  const index = indexSchema(rows);
  for (const row of rows) {
    if (row.type !== "trigger" && row.type !== "view") continue;
    const touched = tablesTouchedBy(row, index);
    if ([...touched].some((table) => alteredSet.has(table))) {
      for (const table of touched) guarded.add(table);
    }
  }
  return [...guarded].sort();
}

export interface GuardUpstreamStepArgs {
  tag: string;
  sql: string;
  guardedTables: readonly string[];
}

export function guardUpstreamStep(args: GuardUpstreamStepArgs): void {
  const guarded = new Set(
    args.guardedTables.map((table) => table.toLowerCase()),
  );
  const rebuilt = scanRebuiltTables(args.sql).filter((table) =>
    guarded.has(table),
  );
  if (rebuilt.length > 0) {
    throw new MigrationGuardError(
      `Upstream step ${args.tag} rebuilds or alters ${rebuilt.join(", ")}, which Aleph alters or references. Add an Aleph step that supersedes it.`,
    );
  }
}

export interface GuardPlanArgs {
  frozen: readonly FrozenUpstreamStep[];
  input: MigrationPlanInput;
  plan: MigrationPlan;
  guardedTables: readonly string[];
  readUpstreamSql: (tag: string) => string;
}

function requireIncreasingWhen(
  plan: MigrationPlan,
  frozenTags: ReadonlySet<string>,
): void {
  let ceiling: { id: string; when: number } | undefined;
  let inTail = false;
  for (const step of plan.steps) {
    if (step.namespace === "upstream" && !frozenTags.has(step.id)) {
      inTail = true;
    }
    if (inTail && ceiling !== undefined && step.when <= ceiling.when) {
      const label = step.namespace === "upstream" ? "Upstream" : "Aleph";
      throw new MigrationGuardError(
        `${label} step ${step.id} has when ${step.when}, which is not after the preceding step ${ceiling.id} (${ceiling.when})`,
      );
    }
    if (ceiling === undefined || step.when > ceiling.when) {
      ceiling = { id: step.id, when: step.when };
    }
  }
}

export function guardPlan(args: GuardPlanArgs): void {
  verifyFrozenSet(args.frozen, args.input);
  const planned = new Set(args.plan.steps.map((step) => step.id));
  const nonFrozen = nonFrozenUpstreamSteps(args.frozen, args.input);
  for (const tag of nonFrozen) {
    if (!planned.has(tag)) {
      throw new MigrationGuardError(
        `Upstream step ${tag} is not in the migration plan`,
      );
    }
  }
  requireIncreasingWhen(
    args.plan,
    new Set(args.frozen.map((step) => step.tag)),
  );
  for (const tag of nonFrozen) {
    guardUpstreamStep({
      tag,
      sql: args.readUpstreamSql(tag),
      guardedTables: args.guardedTables,
    });
  }
}
