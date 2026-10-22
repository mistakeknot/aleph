import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
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
  buildMigrationPlan,
  loadMigrationPlanInput,
  parseAlephAlteredTables,
  parseFrozenUpstream,
  type AlephStepSource,
  type MigrationPlanInput,
  type UpstreamStepSource,
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

function withNewUpstreamStep(
  sql: string,
  when = 9_999_999_999_999,
): {
  input: MigrationPlanInput;
  sqlFor: (tag: string) => string;
} {
  const base = loadMigrationPlanInput(sourceFolders);
  return {
    input: {
      ...base,
      upstream: [
        ...base.upstream,
        { tag: "0144_synthetic", when, sha256: "synthetic" },
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

  it("guards the child side of a foreign key edge", () => {
    const guarded = guardedTables();
    for (const child of [
      "thread_tabs",
      "events",
      "terminal_sessions",
      "environments",
    ]) {
      expect(alteredTables).not.toContain(child);
      expect(guarded).toContain(child);
    }
  });

  it("matches foreign key neighbours without regard to case", () => {
    const sqlite = new Database(":memory:");
    try {
      sqlite.exec(
        "CREATE TABLE Parent (id TEXT PRIMARY KEY); CREATE TABLE Child (id TEXT PRIMARY KEY, parent_id TEXT REFERENCES parent(id)); CREATE TABLE Other (id TEXT PRIMARY KEY);",
      );
      expect(expandWithForeignKeyNeighbours(sqlite, ["PARENT"])).toEqual([
        "child",
        "parent",
      ]);
      expect(expandWithForeignKeyNeighbours(sqlite, ["CHILD"])).toEqual([
        "child",
        "parent",
      ]);
    } finally {
      sqlite.close();
    }
  });

  it("attributes a trigger or view to every table it references", () => {
    const before = new Database(":memory:");
    const after = new Database(":memory:");
    const base =
      "CREATE TABLE a (id TEXT PRIMARY KEY); CREATE TABLE b (id TEXT PRIMARY KEY); CREATE TABLE c (id TEXT PRIMARY KEY);";
    try {
      before.exec(base);
      after.exec(base);
      after.exec(
        "CREATE TRIGGER a_to_b AFTER INSERT ON a BEGIN INSERT INTO b (id) VALUES (new.id); END;",
      );
      expect(computeAlteredTables(before, after)).toEqual(["a", "b"]);
      expect(expandWithForeignKeyNeighbours(after, ["a"])).toEqual(["a", "b"]);
      after.exec("DROP TRIGGER a_to_b");
      after.exec("CREATE VIEW b_and_c AS SELECT b.id FROM b JOIN c");
      expect(computeAlteredTables(before, after)).toEqual([
        "b",
        "b_and_c",
        "c",
      ]);
      expect(expandWithForeignKeyNeighbours(after, ["b"])).toEqual([
        "b",
        "b_and_c",
        "c",
      ]);
    } finally {
      before.close();
      after.close();
    }
  });
});

describe("reference extraction", () => {
  const base =
    "CREATE TABLE a (id TEXT PRIMARY KEY); CREATE TABLE b (id TEXT PRIMARY KEY); CREATE TABLE c (id TEXT PRIMARY KEY); CREATE TABLE d (id TEXT PRIMARY KEY);";

  function schemas(extra: string): {
    before: Database.Database;
    after: Database.Database;
  } {
    const before = new Database(":memory:");
    const after = new Database(":memory:");
    before.exec(base);
    after.exec(base);
    after.exec(extra);
    return { before, after };
  }

  it("follows a view through other views to the base tables", () => {
    const { before, after } = schemas(
      "CREATE VIEW v1 AS SELECT id FROM b; CREATE VIEW v2 AS SELECT id FROM v1;",
    );
    try {
      expect(computeAlteredTables(before, after)).toEqual(["b", "v1", "v2"]);
      expect(expandWithForeignKeyNeighbours(after, ["v2"])).toEqual([
        "b",
        "v2",
      ]);
      expect(expandWithForeignKeyNeighbours(after, ["b"])).toEqual([
        "b",
        "v1",
        "v2",
      ]);
    } finally {
      before.close();
      after.close();
    }
  });

  it("refuses to drop a table that is only reachable through a view chain", () => {
    const { before, after } = schemas(
      "CREATE VIEW v1 AS SELECT id FROM b; CREATE VIEW v2 AS SELECT id FROM v1;",
    );
    try {
      const guarded = expandWithForeignKeyNeighbours(after, ["v2"]);
      expect(guarded).toContain("b");
      const { input, sqlFor } = withNewUpstreamStep("DROP TABLE b;");
      expect(() =>
        guardPlan({
          frozen,
          input,
          plan: buildMigrationPlan(input),
          guardedTables: guarded,
          readUpstreamSql: sqlFor,
        }),
      ).toThrow(/0144_synthetic rebuilds or alters b/);
      void before;
    } finally {
      before.close();
      after.close();
    }
  });

  it("follows a view chain through three levels and a trigger on a view", () => {
    const { after, before } = schemas(
      "CREATE VIEW v1 AS SELECT id FROM c; CREATE VIEW v2 AS SELECT id FROM v1; CREATE VIEW v3 AS SELECT v2.id FROM v2 JOIN a; CREATE TRIGGER t INSTEAD OF INSERT ON v3 BEGIN INSERT INTO d (id) VALUES (new.id); END;",
    );
    try {
      const expected = ["a", "c", "d", "v1", "v2", "v3"];
      expect(expandWithForeignKeyNeighbours(after, ["c"])).toEqual(expected);
      expect(expandWithForeignKeyNeighbours(after, ["d"])).toEqual([
        "a",
        "c",
        "d",
        "v3",
      ]);
    } finally {
      before.close();
      after.close();
    }
  });

  it("treats a view SQLite cannot resolve as touching every table", () => {
    const { after, before } = schemas(
      "CREATE VIEW loop AS SELECT id FROM b WHERE id NOT IN (SELECT id FROM loop2); CREATE VIEW loop2 AS SELECT id FROM loop;",
    );
    try {
      expect(expandWithForeignKeyNeighbours(after, ["b"])).toEqual([
        "a",
        "b",
        "c",
        "d",
        "loop",
        "loop2",
      ]);
    } finally {
      before.close();
      after.close();
    }
  });

  it("ignores a table name that only appears inside a string literal", () => {
    const { before, after } = schemas(
      "CREATE TRIGGER a_log AFTER INSERT ON a BEGIN INSERT INTO c (id) VALUES ('b'); END;",
    );
    try {
      expect(computeAlteredTables(before, after)).toEqual(["a", "c"]);
      expect(expandWithForeignKeyNeighbours(after, ["a"])).toEqual(["a", "c"]);
    } finally {
      before.close();
      after.close();
    }
  });

  it.each([
    [
      "an INSERT INTO target",
      "CREATE TRIGGER a_log AFTER INSERT ON a BEGIN INSERT INTO 'b' (id) VALUES (new.id); END;",
    ],
    [
      "an UPDATE target",
      "CREATE TRIGGER a_log AFTER INSERT ON a BEGIN UPDATE 'b' SET id = id; END;",
    ],
    [
      "a DELETE FROM target",
      "CREATE TRIGGER a_log AFTER INSERT ON a BEGIN DELETE FROM 'b'; END;",
    ],
    [
      "a qualified name",
      "CREATE TRIGGER a_log AFTER INSERT ON a BEGIN INSERT INTO d SELECT 1 FROM 'main'.'b'; END;",
    ],
    [
      "a second FROM item",
      "CREATE TRIGGER a_log AFTER INSERT ON a BEGIN INSERT INTO d SELECT 1 FROM a, 'b'; END;",
    ],
    [
      "a JOIN target",
      "CREATE TRIGGER a_log AFTER INSERT ON a BEGIN INSERT INTO d SELECT 1 FROM a JOIN 'b'; END;",
    ],
  ])(
    "sees a table named by a single-quoted identifier in %s",
    (_name, trigger) => {
      const { before, after } = schemas(trigger);
      try {
        expect(expandWithForeignKeyNeighbours(after, ["a"])).toContain("b");
        expect(computeAlteredTables(before, after)).toContain("b");
      } finally {
        before.close();
        after.close();
      }
    },
  );

  it("sees a table named by a single-quoted identifier inside a view chain", () => {
    const { before, after } = schemas(
      "CREATE VIEW v1 AS SELECT id FROM 'b'; CREATE VIEW v2 AS SELECT id FROM 'v1';",
    );
    try {
      expect(computeAlteredTables(before, after)).toEqual(["b", "v1", "v2"]);
      expect(expandWithForeignKeyNeighbours(after, ["v2"])).toContain("b");
    } finally {
      before.close();
      after.close();
    }
  });

  it("still ignores single-quoted literals in value positions", () => {
    const { before, after } = schemas(
      "CREATE TRIGGER a_log AFTER INSERT ON a WHEN new.id = 'b' BEGIN INSERT INTO c (id) VALUES ('b'); UPDATE c SET id = 'b' WHERE id IN ('b', 'd'); END;",
    );
    try {
      expect(computeAlteredTables(before, after)).toEqual(["a", "c"]);
    } finally {
      before.close();
      after.close();
    }
  });

  const triggerOn = (body: string) =>
    `CREATE TRIGGER a_log AFTER INSERT ON a BEGIN ${body} END;`;

  it.each([
    "UPDATE OR IGNORE 'b' SET id = id;",
    "UPDATE OR REPLACE 'b' SET id = id;",
    "UPDATE OR ABORT 'b' SET id = id;",
    "UPDATE OR FAIL 'b' SET id = id;",
    "UPDATE OR ROLLBACK 'b' SET id = id;",
    "INSERT INTO d SELECT 1 FROM ('b');",
    "INSERT INTO d SELECT 1 FROM c JOIN ('b');",
    "INSERT INTO d SELECT 1 FROM c, ('b');",
    "INSERT INTO d SELECT 1 FROM (SELECT 1) q, 'b';",
    "INSERT INTO d SELECT 1 FROM c JOIN c AS c2 ON c.id = c2.id, 'b';",
    "INSERT INTO d SELECT 1 FROM c JOIN c AS c2 USING (id), 'b';",
    "INSERT INTO d SELECT 1 FROM (SELECT 1 WHERE 1), 'b';",
  ])(
    "sees a table the trigger names in a position SQLite resolves: %s",
    (body) => {
      const { before, after } = schemas(triggerOn(body));
      try {
        expect(expandWithForeignKeyNeighbours(after, ["b"])).toContain("a");
        expect(computeAlteredTables(before, after)).toContain("b");
      } finally {
        before.close();
        after.close();
      }
    },
  );

  it.each([
    "INSERT INTO d SELECT 1 FROM json_each(json_array('a', 'b'));",
    "INSERT INTO d SELECT 1 WHERE new.id IS DISTINCT FROM 'b';",
    "INSERT INTO d SELECT 1 FROM c JOIN c AS c2 ON 'b';",
    "INSERT INTO d SELECT 1 WHERE new.id IS NOT DISTINCT FROM 'b';",
  ])("ignores a literal that only looks like a table: %s", (body) => {
    const { before, after } = schemas(triggerOn(body));
    try {
      expect(expandWithForeignKeyNeighbours(after, ["b"])).not.toContain("a");
      expect(computeAlteredTables(before, after)).not.toContain("b");
    } finally {
      before.close();
      after.close();
    }
  });

  it("still sees a table named by a quoted identifier", () => {
    const { before, after } = schemas(
      'CREATE TRIGGER a_log AFTER INSERT ON a BEGIN INSERT INTO c (id) VALUES (new.id); UPDATE "b" SET id = id; END;',
    );
    try {
      expect(computeAlteredTables(before, after)).toEqual(["a", "b", "c"]);
    } finally {
      before.close();
      after.close();
    }
  });
});

describe("the frozen set", () => {
  it("pins every upstream step, so no step is unguarded", () => {
    const input = loadMigrationPlanInput(sourceFolders);
    expect(frozen).toHaveLength(input.upstream.length);
    expect(nonFrozenUpstreamSteps(frozen, input)).toEqual([]);
  });

  it("refuses a frozen step missing from the upstream journal", () => {
    const input = loadMigrationPlanInput(sourceFolders);
    const trimmed: MigrationPlanInput = {
      ...input,
      upstream: input.upstream.filter(
        (step) => step.tag !== "0036_drop_automations_feature",
      ),
    };
    expect(() => verifyFrozenSet(frozen, trimmed)).toThrow(
      /0036_drop_automations_feature is missing/,
    );
  });

  it("refuses a superseded mark whose replacement does not supersede it", () => {
    const input = loadMigrationPlanInput(sourceFolders);
    const unlinked: MigrationPlanInput = {
      ...input,
      aleph: input.aleph.map((step) => {
        const { supersedes: _dropped, ...rest } = step;
        return rest;
      }),
    };
    expect(() => verifyFrozenSet(frozen, unlinked)).toThrow(
      /marked superseded by A0009, which does not supersede it/,
    );
  });
});

describe("scanRebuiltTables", () => {
  it.each([
    ["a plain drop", "DROP TABLE queued_thread_messages;"],
    ["a drop if exists", "DROP TABLE IF EXISTS queued_thread_messages;"],
    ["an uppercase name", "DROP TABLE QUEUED_THREAD_MESSAGES;"],
    ["a mixed case keyword", "dRoP tAbLe queued_thread_messages;"],
    ["a schema prefix", "DROP TABLE main.queued_thread_messages;"],
    ["a quoted schema prefix", 'DROP TABLE "main"."queued_thread_messages";'],
    ["a single quoted name", "DROP TABLE 'queued_thread_messages';"],
    ["a backtick name", "DROP TABLE `queued_thread_messages`;"],
    ["a double quoted name", 'DROP TABLE "queued_thread_messages";'],
    ["a bracket name", "DROP TABLE [queued_thread_messages];"],
    ["a block comment", "DROP /* c */ TABLE /* d */ queued_thread_messages;"],
    ["a line comment", "DROP -- c\nTABLE queued_thread_messages;"],
    ["newlines", "DROP\n  TABLE\n  queued_thread_messages;"],
    ["a rename", "ALTER TABLE __new_x RENAME TO queued_thread_messages;"],
    ["a rename source", "ALTER TABLE queued_thread_messages RENAME TO x;"],
    [
      "a column rename",
      "ALTER TABLE queued_thread_messages RENAME COLUMN a TO b;",
    ],
    ["a column add", "ALTER TABLE queued_thread_messages ADD COLUMN a text;"],
    [
      "a column add without the keyword",
      "ALTER TABLE queued_thread_messages ADD a text;",
    ],
    ["a column drop", "ALTER TABLE queued_thread_messages DROP COLUMN a;"],
    [
      "a qualified column add",
      "ALTER TABLE main.QUEUED_thread_messages ADD COLUMN a text;",
    ],
    [
      "a standalone staging table",
      "CREATE TABLE `__new_queued_thread_messages` (id text);",
    ],
    [
      "a staging table if not exists",
      "CREATE TABLE IF NOT EXISTS __NEW_Queued_Thread_Messages (id text);",
    ],
  ])("finds the table behind %s", (_name, sql) => {
    expect(scanRebuiltTables(sql)).toContain("queued_thread_messages");
  });

  it("ignores statements that do not rebuild or alter a table", () => {
    expect(
      scanRebuiltTables(
        "CREATE TABLE fresh (id text); CREATE INDEX i ON queued_thread_messages (id); INSERT INTO queued_thread_messages VALUES ('DROP TABLE x'); -- DROP TABLE y\n/* ALTER TABLE z ADD a */",
      ),
    ).toEqual([]);
  });

  it.each([
    [
      "a virtual staging table",
      "CREATE VIRTUAL TABLE __new_queued_thread_messages USING fts5(a);",
    ],
    [
      "a virtual staging table if not exists",
      "CREATE VIRTUAL TABLE IF NOT EXISTS main.__new_queued_thread_messages USING fts5(a);",
    ],
    [
      "a quoted virtual staging table",
      'create virtual table "__NEW_Queued_Thread_Messages" using fts5(a);',
    ],
  ])("finds the table behind %s", (_name, sql) => {
    expect(scanRebuiltTables(sql)).toContain("queued_thread_messages");
  });

  it.each([
    ["a temp drop", "DROP TABLE IF EXISTS temp.queued_thread_messages;"],
    ["a quoted temp drop", 'DROP TABLE "TEMP"."queued_thread_messages";'],
    [
      "a temp column add",
      "ALTER TABLE temp.queued_thread_messages ADD COLUMN a text;",
    ],
    [
      "a temp rename",
      "ALTER TABLE temp.queued_thread_messages RENAME TO queued_thread_messages_old;",
    ],
    [
      "a temp staging table",
      "CREATE TABLE temp.__new_queued_thread_messages (id text);",
    ],
    [
      "a virtual temp staging table",
      "CREATE VIRTUAL TABLE temp.__new_queued_thread_messages USING fts5(a);",
    ],
  ])("ignores %s, which never touches main", (_name, sql) => {
    expect(scanRebuiltTables(sql)).toEqual([]);
  });

  it.each([
    [
      "a comment that ends at its first terminator",
      "/* a /* b */ DROP TABLE t1; */",
      ["t1"],
    ],
    ["an unterminated comment", "/* DROP TABLE t2;", []],
    [
      "comments between the keywords",
      "DROP /*c*/ TABLE /*d*/ IF /*e*/ EXISTS /*f*/ main /*g*/ . /*h*/ t3;",
      ["t3"],
    ],
    ["a line comment", "-- DROP TABLE t4\nDROP TABLE t5;", ["t5"]],
    [
      "a keyword inside a string",
      "SELECT 'DROP TABLE t6'; DROP TABLE t7;",
      ["t7"],
    ],
    ["a quoted main schema", 'DROP TABLE "main"."t8";', ["t8"]],
    [
      "bracket and backtick quoting",
      "DROP TABLE [t9]; DROP TABLE `t10`;",
      ["t10", "t9"],
    ],
    [
      "a statement inside a trigger body",
      "CREATE TRIGGER x AFTER INSERT ON a BEGIN DROP TABLE t11; END;",
      ["t11"],
    ],
    [
      "a CREATE TABLE AS staging table",
      "CREATE TABLE __new_t12 AS SELECT 1;",
      ["t12"],
    ],
    [
      "whitespace-separated rename keywords",
      "alter\ntable\tt13\nrename\nto t14;",
      ["t13", "t14"],
    ],
  ])("reads %s the way SQLite does", (_name, sql, expected) => {
    expect(scanRebuiltTables(sql)).toEqual(expected);
  });

  it.each([
    "CREATE TEMP TABLE __new_queued_thread_messages (id text);",
    "CREATE TEMP TABLE IF NOT EXISTS __new_queued_thread_messages (id text);",
    "CREATE TEMPORARY TABLE __new_queued_thread_messages (id text);",
    "create temporary table if not exists __new_queued_thread_messages (id text);",
    "CREATE TEMP TABLE __new_queued_thread_messages AS SELECT 1;",
  ])("ignores an implicit temp staging table: %s", (sql) => {
    expect(scanRebuiltTables(sql)).toEqual([]);
  });

  it("still finds a main table next to a temp one", () => {
    expect(
      scanRebuiltTables(
        "DROP TABLE temp.a; DROP TABLE main.b; ALTER TABLE temp.c RENAME TO d; ALTER TABLE e RENAME TO temp_f;",
      ),
    ).toEqual(["b", "e", "temp_f"]);
  });

  it.each([
    "CREATE TEMP TABLE __new_b (id); DROP TABLE __new_b;",
    "CREATE TEMP TABLE __new_b (id); ALTER TABLE __new_b RENAME TO c;",
    "CREATE TEMP TABLE t (id); ALTER TABLE t RENAME TO b; DROP TABLE b;",
    "CREATE TEMPORARY TABLE IF NOT EXISTS b (id); DROP TABLE b;",
    "CREATE TEMP TABLE b (id); ALTER TABLE b RENAME TO c; ALTER TABLE c ADD COLUMN x;",
  ])("keeps a temp table's later statements out of main: %s", (sql) => {
    expect(scanRebuiltTables(sql)).toEqual([]);
  });

  it("sees the main table again once the temp one is dropped", () => {
    expect(
      scanRebuiltTables(
        "CREATE TEMP TABLE b (id); DROP TABLE b; DROP TABLE b;",
      ),
    ).toEqual(["b"]);
  });

  it("still sees an explicit main reference to a name used by a temp table", () => {
    expect(
      scanRebuiltTables("CREATE TEMP TABLE b (id); DROP TABLE main.b;"),
    ).toEqual(["b"]);
  });

  it("returns each table once, lower case and sorted", () => {
    expect(
      scanRebuiltTables(
        "CREATE TABLE __new_B (id text); DROP TABLE B; ALTER TABLE __new_B RENAME TO B; DROP TABLE a;",
      ),
    ).toEqual(["a", "b"]);
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
    expect(() =>
      guardPlan({
        frozen,
        input,
        plan: buildMigrationPlan(input),
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
        plan: buildMigrationPlan(input),
        guardedTables: guardedTables(),
        readUpstreamSql: sqlFor,
      }),
    ).toThrow(/0144_synthetic rebuilds or alters queued_thread_messages/);
  });

  it("refuses a new upstream step that rebuilds a merely referenced table", () => {
    const { input, sqlFor } = withNewUpstreamStep(
      "CREATE TABLE `__new_projects` (`id` text PRIMARY KEY NOT NULL);--> statement-breakpoint\nDROP TABLE `projects`;--> statement-breakpoint\nALTER TABLE `__new_projects` RENAME TO `projects`;",
    );
    expect(() =>
      guardPlan({
        frozen,
        input,
        plan: buildMigrationPlan(input),
        guardedTables: guardedTables(),
        readUpstreamSql: sqlFor,
      }),
    ).toThrow(/rebuilds or alters projects/);
  });

  it.each([
    [
      "a column add",
      "ALTER TABLE `queued_thread_messages` ADD COLUMN `x` text;",
    ],
    [
      "a column drop",
      "ALTER TABLE queued_thread_messages DROP COLUMN origin_id;",
    ],
    [
      "a column rename",
      "ALTER TABLE queued_thread_messages RENAME COLUMN origin_id TO x;",
    ],
    [
      "a standalone staging table",
      "CREATE TABLE `__new_queued_thread_messages` (`id` text);",
    ],
    ["an uppercase drop", "DROP TABLE QUEUED_THREAD_MESSAGES;"],
    ["a schema qualified drop", "DROP TABLE main.queued_thread_messages;"],
    ["a single quoted drop", "DROP TABLE 'queued_thread_messages';"],
    [
      "a drop with an embedded comment",
      "DROP /* c */ TABLE queued_thread_messages;",
    ],
  ])(
    "refuses a new upstream step with %s on an altered table",
    (_name, sql) => {
      const { input, sqlFor } = withNewUpstreamStep(sql);
      expect(() =>
        guardPlan({
          frozen,
          input,
          plan: buildMigrationPlan(input),
          guardedTables: guardedTables(),
          readUpstreamSql: sqlFor,
        }),
      ).toThrow(/0144_synthetic rebuilds or alters queued_thread_messages/);
    },
  );

  it("refuses a new upstream step whose when is not after the frozen steps", () => {
    const { input, sqlFor } = withNewUpstreamStep(
      "CREATE TABLE `brand_new_table` (`id` text PRIMARY KEY NOT NULL);",
      1,
    );
    expect(() =>
      guardPlan({
        frozen,
        input,
        plan: buildMigrationPlan(input),
        guardedTables: guardedTables(),
        readUpstreamSql: sqlFor,
      }),
    ).toThrow(/0144_synthetic has when 1, which is not after/);
  });

  it("accepts a new upstream step that touches only unrelated tables", () => {
    const { input, sqlFor } = withNewUpstreamStep(
      "CREATE TABLE `brand_new_table` (`id` text PRIMARY KEY NOT NULL);",
    );
    expect(() =>
      guardPlan({
        frozen,
        input,
        plan: buildMigrationPlan(input),
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

  describe("the when ordering", () => {
    const anchor = "0142_ex88_slot_triggers";
    const lastWhen = Math.max(
      ...loadMigrationPlanInput(sourceFolders).aleph.map((step) => step.when),
      ...loadMigrationPlanInput(sourceFolders).upstream.map(
        (step) => step.when,
      ),
    );

    function guardInput(input: MigrationPlanInput, sql = "SELECT 1;"): void {
      guardPlan({
        frozen,
        input,
        plan: buildMigrationPlan(input),
        guardedTables: guardedTables(),
        readUpstreamSql: (tag) =>
          tag.startsWith("0144") || tag.startsWith("0145")
            ? sql
            : readUpstreamSql(tag),
      });
    }

    function extend(
      upstream: UpstreamStepSource[],
      aleph: AlephStepSource[],
    ): MigrationPlanInput {
      const base = loadMigrationPlanInput(sourceFolders);
      return {
        upstream: [...base.upstream, ...upstream],
        aleph: [...base.aleph, ...aleph],
      };
    }

    function alephStep(
      id: string,
      after: string,
      when: number,
    ): AlephStepSource {
      return { id, file: `${id}.sql`, after, when, sha256: id };
    }

    it("refuses a when equal to the newest earlier step", () => {
      expect(lastWhen).toBeGreaterThan(0);
      const { input, sqlFor } = withNewUpstreamStep("SELECT 1;", lastWhen);
      expect(() =>
        guardPlan({
          frozen,
          input,
          plan: buildMigrationPlan(input),
          guardedTables: guardedTables(),
          readUpstreamSql: sqlFor,
        }),
      ).toThrow(/0144_synthetic has when \d+, which is not after/);
    });

    it("accepts a when one after the newest earlier step", () => {
      const { input, sqlFor } = withNewUpstreamStep("SELECT 1;", lastWhen + 1);
      expect(() =>
        guardPlan({
          frozen,
          input,
          plan: buildMigrationPlan(input),
          guardedTables: guardedTables(),
          readUpstreamSql: sqlFor,
        }),
      ).not.toThrow();
    });

    it("refuses a second new upstream step that is not after the first", () => {
      const input = extend(
        [
          { tag: "0144_first", when: lastWhen + 100, sha256: "first" },
          { tag: "0145_second", when: lastWhen + 50, sha256: "second" },
        ],
        [],
      );
      expect(() => guardInput(input)).toThrow(
        /0145_second has when \d+, which is not after the preceding step 0144_first/,
      );
    });

    it("accepts new upstream steps with increasing whens", () => {
      const input = extend(
        [
          { tag: "0144_first", when: lastWhen + 50, sha256: "first" },
          { tag: "0145_second", when: lastWhen + 100, sha256: "second" },
        ],
        [],
      );
      expect(() => guardInput(input)).not.toThrow();
    });

    it("accepts an upstream step between A0009 and a later Aleph step", () => {
      const input = extend(
        [{ tag: "0144_first", when: lastWhen + 10, sha256: "first" }],
        [alephStep("A0010", "0144_first", lastWhen + 20)],
      );
      expect(
        buildMigrationPlan(input)
          .steps.map((step) => step.id)
          .slice(-3),
      ).toEqual(
        ["A0009_queued_message_state", "0144_first", "A0010"].map((id) =>
          id.startsWith("A0009") ? expect.stringMatching(/^A0009$/) : id,
        ),
      );
      expect(() => guardInput(input)).not.toThrow();
    });

    it("refuses a later Aleph step older than the upstream step before it", () => {
      const input = extend(
        [{ tag: "0144_first", when: lastWhen + 20, sha256: "first" }],
        [alephStep("A0010", "0144_first", lastWhen + 10)],
      );
      expect(() => guardInput(input)).toThrow(
        /Aleph step A0010 has when \d+, which is not after the preceding step 0144_first/,
      );
    });

    it("refuses a new upstream step older than the Aleph step it follows", () => {
      const input = extend(
        [{ tag: "0144_first", when: lastWhen - 1, sha256: "first" }],
        [],
      );
      expect(() => guardInput(input)).toThrow(/0144_first has when/);
    });

    it("accepts a reviewed Aleph step that supersedes a new upstream step", () => {
      const base = loadMigrationPlanInput(sourceFolders);
      const input: MigrationPlanInput = {
        upstream: [
          ...base.upstream,
          { tag: "0144_first", when: lastWhen + 10, sha256: "first" },
        ],
        aleph: [
          ...base.aleph,
          {
            ...alephStep("A0010", "A0009", lastWhen + 20),
            supersedes: "0144_first",
          },
        ],
      };
      const frozenWithNew = [
        ...frozen,
        { tag: "0144_first", sha256: "first", supersededBy: "A0010" },
      ];
      expect(() =>
        guardPlan({
          frozen: frozenWithNew,
          input,
          plan: buildMigrationPlan(input),
          guardedTables: guardedTables(),
          readUpstreamSql: () => "DROP TABLE queued_thread_messages;",
        }),
      ).not.toThrow();
      void anchor;
    });

    it("refuses a plan that omits a new upstream step", () => {
      const { input, sqlFor } = withNewUpstreamStep("SELECT 1;", lastWhen + 1);
      expect(() =>
        guardPlan({
          frozen,
          input,
          plan: buildMigrationPlan(loadMigrationPlanInput(sourceFolders)),
          guardedTables: guardedTables(),
          readUpstreamSql: sqlFor,
        }),
      ).toThrow(/0144_synthetic is not in the migration plan/);
    });
  });
});
