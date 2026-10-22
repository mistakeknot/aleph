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

const DROPPED_TABLE =
  /\bDROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:`([^`]+)`|"([^"]+)"|\[([^\]]+)\]|(\w+))/gi;
const RENAMED_TABLE =
  /\bALTER\s+TABLE\s+(?:`([^`]+)`|"([^"]+)"|\[([^\]]+)\]|(\w+))\s+RENAME\s+TO\s+(?:`([^`]+)`|"([^"]+)"|\[([^\]]+)\]|(\w+))/gi;

function firstDefined(values: readonly (string | undefined)[]): string {
  return values.find((value) => value !== undefined) ?? "";
}

export function splitMigrationStatements(sql: string): string[] {
  return sql
    .split(STATEMENT_BREAKPOINT)
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

export function scanRebuiltTables(sql: string): string[] {
  const rebuilt = new Set<string>();
  for (const match of sql.matchAll(DROPPED_TABLE)) {
    rebuilt.add(firstDefined(match.slice(1, 5)));
  }
  for (const match of sql.matchAll(RENAMED_TABLE)) {
    rebuilt.add(firstDefined(match.slice(1, 5)));
    rebuilt.add(firstDefined(match.slice(5, 9)));
  }
  return [...rebuilt].filter((name) => !name.startsWith("__new_")).sort();
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
  name: string;
  tbl_name: string;
  sql: string | null;
}

function collapseWhitespace(sql: string | null): string {
  return (sql ?? "").replace(/\s+/g, " ").trim();
}

function schemaByTable(sqlite: Database.Database): Map<string, string[]> {
  const rows = sqlite
    .prepare(
      "SELECT name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name <> '__drizzle_migrations' ORDER BY name",
    )
    .all() as SchemaObjectRow[];
  const byTable = new Map<string, string[]>();
  for (const row of rows) {
    const lines = byTable.get(row.tbl_name) ?? [];
    lines.push(`${row.name}|${collapseWhitespace(row.sql)}`);
    byTable.set(row.tbl_name, lines);
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
  const edges = sqlite
    .prepare(
      "SELECT m.name AS child, f.\"table\" AS parent FROM sqlite_master m, pragma_foreign_key_list(m.name) f WHERE m.type = 'table'",
    )
    .all() as Array<{ child: string; parent: string }>;
  const guarded = new Set(altered);
  for (const edge of edges) {
    if (altered.includes(edge.child)) guarded.add(edge.parent);
    if (altered.includes(edge.parent)) guarded.add(edge.child);
  }
  return [...guarded].sort();
}

export interface GuardUpstreamStepArgs {
  tag: string;
  sql: string;
  guardedTables: readonly string[];
}

export function guardUpstreamStep(args: GuardUpstreamStepArgs): void {
  const guarded = new Set(args.guardedTables);
  const rebuilt = scanRebuiltTables(args.sql).filter((table) =>
    guarded.has(table),
  );
  if (rebuilt.length > 0) {
    throw new MigrationGuardError(
      `Upstream step ${args.tag} rebuilds ${rebuilt.join(", ")}, which Aleph alters or references. Add an Aleph step that supersedes it.`,
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

export function guardPlan(args: GuardPlanArgs): void {
  verifyFrozenSet(args.frozen, args.input);
  for (const tag of nonFrozenUpstreamSteps(args.frozen, args.input)) {
    guardUpstreamStep({
      tag,
      sql: args.readUpstreamSql(tag),
      guardedTables: args.guardedTables,
    });
  }
}
