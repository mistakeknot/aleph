import { randomBytes } from "node:crypto";
import Database from "better-sqlite3";
import { registerHostPathSqlFunctions } from "./data/host-path-sql.js";
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

export function trimMigrationStatement(statement: string): string {
  return statement.trim();
}

export function splitMigrationStatements(sql: string): string[] {
  return sql
    .split(STATEMENT_BREAKPOINT)
    .map(trimMigrationStatement)
    .filter((statement) => statement.length > 0);
}

type TokenKind = "word" | "quoted" | "string" | "punct";

interface Token {
  kind: TokenKind;
  value: string;
}

const SQL_WHITESPACE = /^[ \t\n\f\r]$/;

export function foldName(name: string): string {
  return name.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

function foldKeyword(name: string): string {
  return name.replace(/[a-z]/g, (letter) => letter.toUpperCase());
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
    if (
      SQL_WHITESPACE.test(character) ||
      character === "\ufeff" ||
      (character === "\u000b" &&
        index > 0 &&
        (SQL_WHITESPACE.test(sql.charAt(index - 1)) ||
          sql.charAt(index - 1) === "\u000b"))
    ) {
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
    foldKeyword(token.value) === keyword
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
  const folded = foldName(name);
  return folded.startsWith(NEW_TABLE_PREFIX)
    ? folded.slice(NEW_TABLE_PREFIX.length)
    : folded;
}

const REFUSED_CONTROL_CHARACTER = /[\u0000-\u0008\u000e-\u001f\u007f]/;

export function refuseUnmodelledCharacters(sql: string): void {
  const refused = REFUSED_CONTROL_CHARACTER.exec(sql);
  if (refused !== null) {
    throw new MigrationGuardError(
      `Migration SQL contains control character U+${refused[0]
        .charCodeAt(0)
        .toString(16)
        .padStart(
          4,
          "0",
        )} at offset ${refused.index}, which the guard does not model`,
    );
  }
}

const STRING_IDENTIFIER_PRECEDERS = new Set([
  "TABLE",
  "INDEX",
  "TRIGGER",
  "VIEW",
  "INTO",
  "UPDATE",
  "JOIN",
  "REFERENCES",
  "TO",
  "COLUMN",
]);

const FROM_CLAUSE_ENDERS = new Set([
  "WHERE",
  "GROUP",
  "ORDER",
  "HAVING",
  "LIMIT",
  "UNION",
  "EXCEPT",
  "INTERSECT",
  "WINDOW",
  "SELECT",
  "VALUES",
  "RETURNING",
  "SET",
]);

const STATEMENT_VERBS = new Set([
  "SELECT",
  "INSERT",
  "UPDATE",
  "DELETE",
  "REPLACE",
  "VALUES",
  "DROP",
  "ALTER",
  "CREATE",
  "PRAGMA",
  "VACUUM",
  "REINDEX",
  "ANALYZE",
  "ATTACH",
  "DETACH",
  "BEGIN",
  "COMMIT",
  "END",
  "SAVEPOINT",
  "RELEASE",
  "ROLLBACK",
  "EXPLAIN",
]);

function keywordAt(
  tokens: readonly Token[],
  position: number,
): string | undefined {
  const token = tokens[position];
  return token !== undefined && token.kind === "word"
    ? foldKeyword(token.value)
    : undefined;
}

function isFromKeyword(tokens: readonly Token[], position: number): boolean {
  return (
    keywordAt(tokens, position) === "FROM" &&
    keywordAt(tokens, position - 1) !== "DISTINCT"
  );
}

const LITERAL_OPERATORS = new Set([
  "=",
  "!",
  "<",
  ">",
  "|",
  "+",
  "-",
  "*",
  "/",
  "%",
  "&",
  "~",
]);

const LITERAL_PRECEDING_KEYWORDS = new Set([
  "AND",
  "OR",
  "NOT",
  "LIKE",
  "GLOB",
  "IS",
  "BETWEEN",
  "DISTINCT",
  "THEN",
  "ELSE",
  "WHEN",
  "CASE",
  "ESCAPE",
  "MATCH",
  "REGEXP",
  "DEFAULT",
  "VALUES",
  "LIMIT",
  "OFFSET",
]);

const LITERAL_FOLLOWING_KEYWORDS = new Set([
  "IS",
  "LIKE",
  "GLOB",
  "IN",
  "BETWEEN",
  "NOT",
  "COLLATE",
  "MATCH",
  "REGEXP",
]);

export function statementVerb(statement: string): string {
  const tokens = tokenize(statement);
  const withClause = keywordAt(tokens, 0) === "WITH";
  let depth = 0;
  for (let position = 0; position < tokens.length; position += 1) {
    const token = tokens[position];
    if (token === undefined) continue;
    if (token.kind === "punct") {
      if (token.value === "(") depth += 1;
      else if (token.value === ")") depth -= 1;
      continue;
    }
    if (depth !== 0 || token.kind !== "word") continue;
    const keyword = foldKeyword(token.value);
    if (keyword === "WITH" || keyword === "RECURSIVE") continue;
    if (!STATEMENT_VERBS.has(keyword)) continue;
    if (withClause) {
      const previous = tokens[position - 1];
      if (previous?.kind !== "punct" || previous.value !== ")") continue;
    }
    return keyword.toLowerCase();
  }
  return "";
}

type ParenthesisKind = "group" | "list";

function isLiteralString(
  tokens: readonly Token[],
  position: number,
  kinds: readonly ParenthesisKind[],
  depth: number,
): boolean {
  const before = tokens[position - 1];
  const after = tokens[position + 1];
  if (before?.kind === "punct" && LITERAL_OPERATORS.has(before.value)) {
    return true;
  }
  if (after?.kind === "punct" && LITERAL_OPERATORS.has(after.value)) {
    return true;
  }
  const afterKeyword = keywordAt(tokens, position + 1);
  if (
    afterKeyword !== undefined &&
    LITERAL_FOLLOWING_KEYWORDS.has(afterKeyword)
  ) {
    return true;
  }
  const beforeKeyword = keywordAt(tokens, position - 1);
  if (beforeKeyword === "FROM") return !isFromKeyword(tokens, position - 1);
  if (beforeKeyword !== undefined) {
    if (STRING_IDENTIFIER_PRECEDERS.has(beforeKeyword)) return false;
    return LITERAL_PRECEDING_KEYWORDS.has(beforeKeyword);
  }
  if (before?.kind === "punct" && before.value === ",") {
    return kinds[depth] === "list";
  }
  if (before?.kind === "punct" && before.value === "(") {
    return kinds[depth] === "list";
  }
  return false;
}

function inValuesRows(tokens: readonly Token[], from: number): boolean {
  let nesting = 0;
  for (let index = from; index >= 0; index -= 1) {
    const token = tokens[index];
    if (token === undefined) continue;
    if (token.kind === "punct") {
      if (token.value === ")") nesting += 1;
      else if (token.value === "(") {
        if (nesting === 0) return false;
        nesting -= 1;
      } else if (token.value === ";" && nesting === 0) return false;
    } else if (token.kind === "word" && nesting === 0) {
      const word = token.value.toUpperCase();
      if (word === "VALUES") return true;
      if (STATEMENT_VERBS.has(word) || FROM_CLAUSE_ENDERS.has(word)) {
        return false;
      }
      if (word === "FROM" || word === "JOIN" || word === "SELECT") return false;
    }
  }
  return false;
}

const COMPOUND_SELECT_KEYWORDS = new Set([
  "SELECT",
  "UNION",
  "INTERSECT",
  "EXCEPT",
]);

export function statementIdentifiers(statement: string): string[] {
  const tokens = tokenize(statement);
  let depth = 0;
  const kinds: ParenthesisKind[] = ["group"];
  const identifiers = new Set<string>();
  for (let position = 0; position < tokens.length; position += 1) {
    const token = tokens[position];
    if (token === undefined) continue;
    if (token.kind === "punct") {
      if (token.value === "(") {
        const opener = keywordAt(tokens, position - 1);
        const before = tokens[position - 1];
        const parent = kinds[depth] ?? "group";
        depth += 1;
        const inner = keywordAt(tokens, position + 1);
        if (inner === "SELECT" || inner === "WITH" || inner === "VALUES")
          kinds[depth] = "group";
        else if (opener === "IN" || opener === "VALUES") kinds[depth] = "list";
        else if (
          before?.kind === "word" &&
          opener !== undefined &&
          !STATEMENT_VERBS.has(opener) &&
          !FROM_CLAUSE_ENDERS.has(opener) &&
          opener !== "FROM" &&
          opener !== "JOIN" &&
          opener !== "AS" &&
          opener !== "ON" &&
          opener !== "AND" &&
          opener !== "OR" &&
          opener !== "NOT" &&
          opener !== "WHERE"
        ) {
          kinds[depth] = "list";
        } else if (before?.kind === "punct" && before.value === ",") {
          kinds[depth] = inValuesRows(tokens, position - 1) ? "list" : parent;
        } else if (before?.kind === "punct" && before.value === "(") {
          kinds[depth] = parent;
        } else kinds[depth] = "group";
      } else if (token.value === ")") {
        depth = Math.max(0, depth - 1);
      }
      continue;
    }
    if (
      token.kind === "word" &&
      kinds[depth] === "list" &&
      COMPOUND_SELECT_KEYWORDS.has(token.value.toUpperCase())
    ) {
      kinds[depth] = "group";
    }
    if (
      token.kind === "string" &&
      isLiteralString(tokens, position, kinds, depth)
    ) {
      continue;
    }
    identifiers.add(normalizeTableName(token.value));
  }
  return [...identifiers];
}

export function scanRebuiltTables(sql: string): string[] {
  refuseUnmodelledCharacters(sql);
  const tokens = splitMigrationStatements(sql).flatMap((chunk): Token[] => [
    ...tokenize(chunk),
    { kind: "punct", value: ";" },
  ]);
  const rebuilt = new Set<string>();
  const tempNames = new Set<string>();
  const isTemporary = (table: TableReference): boolean =>
    table.schema === undefined
      ? tempNames.has(foldName(table.name))
      : foldName(table.schema) === "temp";
  const add = (table: TableReference | undefined) => {
    if (table === undefined || table.name.length === 0) return;
    if (isTemporary(table)) return;
    rebuilt.add(normalizeTableName(table.name));
  };
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const explained =
      isKeyword(tokens[index - 1], "EXPLAIN") ||
      (isKeyword(tokens[index - 3], "EXPLAIN") &&
        isKeyword(tokens[index - 2], "QUERY") &&
        isKeyword(tokens[index - 1], "PLAN"));
    if (isKeyword(token, "ROLLBACK")) {
      tempNames.clear();
    } else if (
      isKeyword(token, "DROP") &&
      isKeyword(tokens[index + 1], "TABLE")
    ) {
      let cursor = index + 2;
      if (
        isKeyword(tokens[cursor], "IF") &&
        isKeyword(tokens[cursor + 1], "EXISTS")
      ) {
        cursor += 2;
      }
      const dropped = readTableName(tokens, cursor);
      add(dropped);
      if (!explained && dropped !== undefined && isTemporary(dropped)) {
        tempNames.delete(foldName(dropped.name));
      }
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
          if (isTemporary(table)) {
            if (explained) continue;
            tempNames.delete(foldName(table.name));
            tempNames.add(foldName(target.name));
          } else {
            add({ ...target, schema: table.schema });
          }
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
      const temporary = cursor > index + 1;
      if (isKeyword(tokens[cursor], "VIRTUAL")) cursor += 1;
      if (!isKeyword(tokens[cursor], "TABLE")) continue;
      cursor += 1;
      const ifNotExists =
        isKeyword(tokens[cursor], "IF") &&
        isKeyword(tokens[cursor + 1], "NOT") &&
        isKeyword(tokens[cursor + 2], "EXISTS");
      if (ifNotExists) cursor += 3;
      const created = readTableName(tokens, cursor);
      if (created === undefined) continue;
      if (explained) continue;
      if (
        temporary ||
        (created.schema !== undefined && foldName(created.schema) === "temp")
      ) {
        if (!ifNotExists) tempNames.add(foldName(created.name));
      } else if (foldName(created.name).startsWith(NEW_TABLE_PREFIX)) {
        rebuilt.add(normalizeTableName(created.name));
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
  return (sql ?? "").replace(/[ \t\n\f\r]+/g, " ").trim();
}

function readSchemaObjects(sqlite: Database.Database): SchemaObjectRow[] {
  return sqlite
    .prepare(
      "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name <> '__drizzle_migrations' ORDER BY name",
    )
    .all() as SchemaObjectRow[];
}

type SchemaDependencies = ReadonlyMap<string, ReadonlySet<string>>;

function dependencyKey(type: string, name: string): string {
  return `${type}:${foldName(name)}`;
}

function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

const VIRTUAL_TABLE_DECLARATION =
  /^[ \t\n\f\r]*CREATE[ \t\n\f\r]+VIRTUAL[ \t\n\f\r]+TABLE\b/i;

function moduleArguments(sql: string): Token[][] {
  const tokens = tokenize(sql);
  if (
    !isKeyword(tokens[0], "CREATE") ||
    !isKeyword(tokens[1], "VIRTUAL") ||
    !isKeyword(tokens[2], "TABLE")
  ) {
    return [];
  }
  let cursor = 3;
  if (
    isKeyword(tokens[cursor], "IF") &&
    isKeyword(tokens[cursor + 1], "NOT") &&
    isKeyword(tokens[cursor + 2], "EXISTS")
  ) {
    cursor += 3;
  }
  const table = readTableName(tokens, cursor);
  if (table === undefined) return [];
  cursor = table.next;
  const opening = tokens[cursor + 2];
  if (
    !isKeyword(tokens[cursor], "USING") ||
    !isName(tokens[cursor + 1]) ||
    opening?.kind !== "punct" ||
    opening.value !== "("
  ) {
    return [];
  }
  const args: Token[][] = [];
  let current: Token[] = [];
  let depth = 1;
  for (const token of tokens.slice(cursor + 3)) {
    if (token.kind === "punct" && token.value === "(") depth += 1;
    if (token.kind === "punct" && token.value === ")") {
      depth -= 1;
      if (depth === 0) {
        args.push(current);
        return args;
      }
    }
    if (token.kind === "punct" && token.value === "," && depth === 1) {
      args.push(current);
      current = [];
    } else {
      current.push(token);
    }
  }
  return args;
}

function contentTableOf(row: SchemaObjectRow): string | undefined {
  if (row.type !== "table" || row.sql === null) return undefined;
  for (const argument of moduleArguments(row.sql)) {
    const [option, equals, value] = argument;
    if (
      argument.length !== 3 ||
      !isKeyword(option, "CONTENT") ||
      equals?.kind !== "punct" ||
      equals.value !== "=" ||
      !isName(value)
    ) {
      continue;
    }
    return value.value.length === 0 ? undefined : foldName(value.value);
  }
  return undefined;
}

function isVirtualTable(row: SchemaObjectRow): boolean {
  return (
    row.type === "table" &&
    row.sql !== null &&
    VIRTUAL_TABLE_DECLARATION.test(row.sql)
  );
}

function findBrokenObject(
  error: unknown,
  candidates: readonly SchemaObjectRow[],
): SchemaObjectRow | undefined {
  const message = error instanceof Error ? error.message : String(error);
  let best: SchemaObjectRow | undefined;
  for (const row of candidates) {
    if (row.type !== "view" && row.type !== "trigger") continue;
    if (!message.startsWith(`error in ${row.type} ${row.name}: `)) continue;
    if (best === undefined || row.name.length > best.name.length) best = row;
  }
  return best;
}

function findDependencies(
  sqlite: Database.Database,
  rows: readonly SchemaObjectRow[],
): SchemaDependencies {
  const dependencies = new Map<string, Set<string>>();
  const record = (key: string, table: string) => {
    const set = dependencies.get(key) ?? new Set<string>();
    set.add(table);
    dependencies.set(key, set);
  };
  for (const row of rows) {
    const content = contentTableOf(row);
    if (content !== undefined)
      record(dependencyKey("table", row.name), content);
  }
  const views = rows.filter((row) => row.type === "view");
  const triggers = rows.filter((row) => row.type === "trigger");
  if (views.length === 0 && triggers.length === 0) return dependencies;
  const tables = rows.filter((row) => row.type === "table" && row.sql !== null);
  const everyTable = new Set(tables.map((table) => foldName(table.name)));
  const taken = new Set(rows.map((row) => foldName(row.name)));
  let probeName = `__guard_probe_${randomBytes(6).toString("hex")}`;
  while (taken.has(probeName)) {
    probeName = `__guard_probe_${randomBytes(6).toString("hex")}`;
  }
  const renamedProbe = `${probeName}_r`;
  const probe = new Database(sqlite.serialize());
  try {
    registerHostPathSqlFunctions(probe);
    probe.pragma("foreign_keys = OFF");
    probe.exec(`CREATE TABLE ${quoteIdentifier(probeName)} (id)`);
    const viewIsBroken = (name: string): boolean => {
      try {
        probe.prepare(`SELECT * FROM ${quoteIdentifier(name)} LIMIT 0`).all();
        return false;
      } catch {
        return true;
      }
    };
    const dropObject = (object: SchemaObjectRow): void => {
      const keyword = object.type === "view" ? "VIEW" : "TRIGGER";
      probe.exec(`DROP ${keyword} IF EXISTS ${quoteIdentifier(object.name)}`);
    };
    const nextBroken = (): SchemaObjectRow | undefined => {
      try {
        probe.exec(
          `ALTER TABLE ${quoteIdentifier(probeName)} RENAME TO ${quoteIdentifier(renamedProbe)}`,
        );
        probe.exec(
          `ALTER TABLE ${quoteIdentifier(renamedProbe)} RENAME TO ${quoteIdentifier(probeName)}`,
        );
        return undefined;
      } catch (error) {
        const broken = findBrokenObject(error, rows);
        if (broken === undefined) {
          throw new MigrationGuardError(
            `Could not read the schema dependencies: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        return broken;
      }
    };
    const drainBroken = (onBroken: (object: SchemaObjectRow) => void): void => {
      const seen = new Set<string>();
      for (let broken = nextBroken(); broken !== undefined;) {
        const key = dependencyKey(broken.type, broken.name);
        if (seen.has(key)) {
          throw new MigrationGuardError(
            `Could not remove the broken schema object ${broken.type} ${broken.name}`,
          );
        }
        seen.add(key);
        onBroken(broken);
        dropObject(broken);
        broken = nextBroken();
      }
    };
    const unanalyzable = new Set<string>();
    for (const view of views) {
      if (!viewIsBroken(view.name)) continue;
      unanalyzable.add(dependencyKey("view", view.name));
      dropObject(view);
    }
    drainBroken((object) =>
      unanalyzable.add(dependencyKey(object.type, object.name)),
    );
    for (const key of unanalyzable) {
      const set = dependencies.get(key) ?? new Set<string>();
      for (const table of everyTable) set.add(table);
      dependencies.set(key, set);
    }
    for (const table of tables) {
      const name = foldName(table.name);
      probe.exec("BEGIN");
      try {
        try {
          probe.exec(`DROP TABLE ${quoteIdentifier(table.name)}`);
        } catch {
          continue;
        }
        for (const view of views) {
          const key = dependencyKey("view", view.name);
          if (unanalyzable.has(key) || !viewIsBroken(view.name)) continue;
          record(key, name);
          dropObject(view);
        }
        drainBroken((object) =>
          record(dependencyKey(object.type, object.name), name),
        );
      } finally {
        probe.exec("ROLLBACK");
      }
    }
  } finally {
    probe.close();
  }
  return dependencies;
}

function tablesTouchedBy(
  row: SchemaObjectRow,
  dependencies: SchemaDependencies,
): Set<string> {
  const touched = new Set<string>([foldName(row.tbl_name)]);
  const keys = [
    dependencyKey("view", row.tbl_name),
    dependencyKey(row.type, row.name),
  ];
  for (const key of keys) {
    for (const table of dependencies.get(key) ?? []) touched.add(table);
  }
  const pending = [...touched];
  for (let table = pending.pop(); table !== undefined; table = pending.pop()) {
    const backings = [
      ...(dependencies.get(dependencyKey("table", table)) ?? []),
      ...(dependencies.get(dependencyKey("view", table)) ?? []),
    ];
    for (const backing of backings) {
      if (touched.has(backing)) continue;
      touched.add(backing);
      pending.push(backing);
    }
  }
  return touched;
}

function schemaByTable(sqlite: Database.Database): Map<string, string[]> {
  const rows = readSchemaObjects(sqlite);
  const dependencies = findDependencies(sqlite, rows);
  const byTable = new Map<string, string[]>();
  for (const row of rows) {
    for (const table of tablesTouchedBy(row, dependencies)) {
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
  const alteredSet = new Set(altered.map((table) => foldName(table)));
  const edges = sqlite
    .prepare(
      "SELECT m.name AS child, f.\"table\" AS parent FROM sqlite_master m, pragma_foreign_key_list(m.name) f WHERE m.type = 'table'",
    )
    .all() as Array<{ child: string; parent: string }>;
  const guarded = new Set(alteredSet);
  for (const edge of edges) {
    const child = foldName(edge.child);
    const parent = foldName(edge.parent);
    if (alteredSet.has(child)) guarded.add(parent);
    if (alteredSet.has(parent)) guarded.add(child);
  }
  const rows = readSchemaObjects(sqlite);
  const dependencies = findDependencies(sqlite, rows);
  for (const row of rows) {
    if (row.type !== "trigger" && row.type !== "view" && !isVirtualTable(row)) {
      continue;
    }
    const touched = tablesTouchedBy(row, dependencies);
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
  const guarded = new Set(args.guardedTables.map((table) => foldName(table)));
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
  readAlephSql: (id: string) => string;
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
  for (const step of args.plan.steps) {
    if (step.namespace !== "aleph") continue;
    try {
      refuseUnmodelledCharacters(args.readAlephSql(step.id));
    } catch (error) {
      if (error instanceof MigrationGuardError) {
        throw new MigrationGuardError(
          `Aleph step ${step.id}: ${error.message}`,
        );
      }
      throw error;
    }
  }
  for (const tag of nonFrozen) {
    guardUpstreamStep({
      tag,
      sql: args.readUpstreamSql(tag),
      guardedTables: args.guardedTables,
    });
  }
}
