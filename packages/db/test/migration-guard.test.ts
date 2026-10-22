import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  computeAlteredTables,
  expandWithForeignKeyNeighbours,
  guardPlan,
  MigrationGuardError,
  nonFrozenUpstreamSteps,
  scanRebuiltTables,
  verifyFrozenSet,
} from "../src/migration-guard.js";
import {
  loadMigrationPlan,
  loadMigrationPlanInput,
  parseAlephAlteredTables,
  parseFrozenUpstream,
  type MigrationPlanInput,
} from "../src/migration-plan.js";
import {
  applyPlan,
  applyUpstreamOnly,
  sourceFolders,
} from "./helpers/plan-apply.js";

const frozen = parseFrozenUpstream(
  JSON.parse(
    readFileSync(
      join(sourceFolders.alephFolder, "frozen-upstream.json"),
      "utf8",
    ),
  ),
);
const alteredTables = parseAlephAlteredTables(
  JSON.parse(
    readFileSync(
      join(sourceFolders.alephFolder, "aleph-altered-tables.json"),
      "utf8",
    ),
  ),
);

function readUpstreamSql(tag: string): string {
  return readFileSync(join(sourceFolders.upstreamFolder, `${tag}.sql`), "utf8");
}

function guardedTables(): string[] {
  const sqlite = applyPlan();
  try {
    return expandWithForeignKeyNeighbours(sqlite, alteredTables);
  } finally {
    sqlite.close();
  }
}

function withNewUpstreamStep(sql: string): {
  input: MigrationPlanInput;
  sqlFor: (tag: string) => string;
} {
  const base = loadMigrationPlanInput(sourceFolders);
  return {
    input: {
      ...base,
      upstream: [
        ...base.upstream,
        { tag: "0144_synthetic", when: 9_999_999_999_999, sha256: "synthetic" },
      ],
    },
    sqlFor: (tag) => (tag === "0144_synthetic" ? sql : readUpstreamSql(tag)),
  };
}

describe("the Aleph altered tables", () => {
  it("equals the tables the schema says Aleph changed", () => {
    const upstreamOnly = applyUpstreamOnly();
    const withAleph = applyPlan();
    try {
      expect(computeAlteredTables(upstreamOnly, withAleph)).toEqual(
        alteredTables,
      );
    } finally {
      upstreamOnly.close();
      withAleph.close();
    }
  });

  it("guards the tables foreign keys connect to the altered ones", () => {
    const guarded = guardedTables();
    expect(guarded).toEqual(expect.arrayContaining(alteredTables));
    expect(guarded).toContain("projects");
    expect(alteredTables).not.toContain("projects");
  });
});

describe("guardPlan", () => {
  it("accepts the real plan, frozen steps included", () => {
    const input = loadMigrationPlanInput(sourceFolders);
    const guarded = guardedTables();
    for (const tag of [
      "0036_drop_automations_feature",
      "0132_thread_drafts",
      "0133_remove_thread_drafts",
      "0143_queued_message_state",
    ]) {
      expect(frozen.map((step) => step.tag)).toContain(tag);
    }
    expect(nonFrozenUpstreamSteps(frozen, input)).toEqual([]);
    expect(() =>
      guardPlan({
        frozen,
        input,
        plan: loadMigrationPlan(sourceFolders),
        guardedTables: guarded,
        readUpstreamSql,
      }),
    ).not.toThrow();
  });

  it("exempts frozen steps that rebuild guarded tables", () => {
    const guarded = guardedTables();
    const rebuilt = scanRebuiltTables(
      readUpstreamSql("0143_queued_message_state"),
    );
    expect(rebuilt.some((table) => guarded.includes(table))).toBe(true);
  });

  it("refuses a new upstream step that rebuilds an altered table", () => {
    const { input, sqlFor } = withNewUpstreamStep(
      "CREATE TABLE `__new_queued_thread_messages` (`id` text PRIMARY KEY NOT NULL);--> statement-breakpoint\nDROP TABLE `queued_thread_messages`;--> statement-breakpoint\nALTER TABLE `__new_queued_thread_messages` RENAME TO `queued_thread_messages`;",
    );
    expect(() =>
      guardPlan({
        frozen,
        input,
        plan: loadMigrationPlan(sourceFolders),
        guardedTables: guardedTables(),
        readUpstreamSql: sqlFor,
      }),
    ).toThrow(/0144_synthetic rebuilds queued_thread_messages/);
  });

  it("refuses a new upstream step that rebuilds a merely referenced table", () => {
    const { input, sqlFor } = withNewUpstreamStep(
      "CREATE TABLE `__new_projects` (`id` text PRIMARY KEY NOT NULL);--> statement-breakpoint\nDROP TABLE `projects`;--> statement-breakpoint\nALTER TABLE `__new_projects` RENAME TO `projects`;",
    );
    expect(() =>
      guardPlan({
        frozen,
        input,
        plan: loadMigrationPlan(sourceFolders),
        guardedTables: guardedTables(),
        readUpstreamSql: sqlFor,
      }),
    ).toThrow(/rebuilds projects/);
  });

  it("accepts a new upstream step that touches only unrelated tables", () => {
    const { input, sqlFor } = withNewUpstreamStep(
      "CREATE TABLE `brand_new_table` (`id` text PRIMARY KEY NOT NULL);",
    );
    expect(() =>
      guardPlan({
        frozen,
        input,
        plan: loadMigrationPlan(sourceFolders),
        guardedTables: guardedTables(),
        readUpstreamSql: sqlFor,
      }),
    ).not.toThrow();
  });

  it("fails the hash pin when a frozen file changes by one byte", () => {
    const input = loadMigrationPlanInput(sourceFolders);
    const tampered: MigrationPlanInput = {
      ...input,
      upstream: input.upstream.map((step) =>
        step.tag === "0036_drop_automations_feature"
          ? { ...step, sha256: `${step.sha256.slice(0, -1)}0` }
          : step,
      ),
    };
    const baseline = input.upstream.find(
      (step) => step.tag === "0036_drop_automations_feature",
    );
    expect(
      tampered.upstream.find((step) => step.tag === baseline?.tag),
    ).not.toEqual(baseline);
    expect(() => verifyFrozenSet(frozen, tampered)).toThrow(
      MigrationGuardError,
    );
    expect(() => verifyFrozenSet(frozen, tampered)).toThrow(
      /0036_drop_automations_feature changed/,
    );
  });

  it("refuses a supersession the frozen set does not record", () => {
    const input = loadMigrationPlanInput(sourceFolders);
    const unrecorded = frozen.map((step) => {
      const { supersededBy: _dropped, ...rest } = step;
      return rest;
    });
    expect(() => verifyFrozenSet(unrecorded, input)).toThrow(
      /not frozen as superseded/,
    );
  });

  it("fails when upstream 0143 is forced onto a schema that has origin_id", () => {
    const sqlite = applyPlan();
    try {
      const columns = sqlite
        .prepare("SELECT name FROM pragma_table_info('queued_thread_messages')")
        .all() as Array<{ name: string }>;
      expect(columns.map((column) => column.name)).toContain("origin_id");
      const statements = readUpstreamSql("0143_queued_message_state")
        .split("--> statement-breakpoint")
        .map((statement) => statement.trim())
        .filter((statement) => statement.length > 0);
      expect(() => {
        for (const statement of statements) sqlite.exec(statement);
      }).toThrow();
    } finally {
      sqlite.close();
    }
  });
});
