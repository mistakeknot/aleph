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
  splitMigrationStatements,
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
import { registerHostPathSqlFunctions } from "../src/data/host-path-sql.js";
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

const alephFileById = new Map(
  loadMigrationPlanInput(sourceFolders).aleph.map((step) => [
    step.id,
    step.file,
  ]),
);

function readAlephSql(id: string): string {
  const file = alephFileById.get(id);
  if (file === undefined) return "SELECT 1;";
  return readFileSync(join(sourceFolders.alephFolder, file), "utf8");
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
          readAlephSql,
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

  it("attributes a view and a trigger that share a name without looping", () => {
    const { before, after } = schemas(
      "CREATE VIEW same AS SELECT id FROM c; CREATE TRIGGER same AFTER INSERT ON a BEGIN INSERT INTO b (id) VALUES (new.id); END;",
    );
    try {
      expect(expandWithForeignKeyNeighbours(after, ["b"])).toEqual(["a", "b"]);
      expect(expandWithForeignKeyNeighbours(after, ["c"])).toEqual([
        "c",
        "same",
      ]);
      expect(computeAlteredTables(before, after)).toContain("b");
    } finally {
      before.close();
      after.close();
    }
  });

  it("reads a trigger name that contains a colon and a space", () => {
    const { after } = schemas(
      'CREATE TRIGGER "x: y" AFTER INSERT ON a BEGIN INSERT INTO b (id) VALUES (new.id); END;',
    );
    try {
      expect(expandWithForeignKeyNeighbours(after, ["b"])).toContain("a");
    } finally {
      after.close();
    }
  });

  it("does not collide with a table named like the probe", () => {
    const { after } = schemas(
      "CREATE TABLE __guard_probe (id); CREATE TABLE __guard_probe_r (id); CREATE VIEW v AS SELECT id FROM b;",
    );
    try {
      expect(expandWithForeignKeyNeighbours(after, ["b"])).toEqual(["b", "v"]);
    } finally {
      after.close();
    }
  });

  it("resolves the SQL functions the application registers", () => {
    const { after } = schemas(
      "CREATE VIEW v AS SELECT bb_host_path_key(id) AS k FROM a;",
    );
    try {
      registerHostPathSqlFunctions(after);
      expect(expandWithForeignKeyNeighbours(after, ["b"])).toEqual(["b"]);
      expect(expandWithForeignKeyNeighbours(after, ["a"])).toEqual(["a", "v"]);
    } finally {
      after.close();
    }
  });

  it("treats a view over an unregistered function as touching every table", () => {
    const { after } = schemas(
      "CREATE VIEW v AS SELECT custom_check(id) AS k FROM a;",
    );
    try {
      expect(expandWithForeignKeyNeighbours(after, ["b"])).toEqual([
        "a",
        "b",
        "c",
        "d",
        "v",
      ]);
    } finally {
      after.close();
    }
  });

  it("follows an external-content full-text table to its backing table", () => {
    const { after } = schemas(
      "CREATE VIRTUAL TABLE f USING fts5(id, content='b', content_rowid='rowid'); CREATE VIEW v AS SELECT id FROM f;",
    );
    try {
      expect(expandWithForeignKeyNeighbours(after, ["v"])).toEqual([
        "b",
        "f",
        "v",
      ]);
      expect(expandWithForeignKeyNeighbours(after, ["b"])).toEqual([
        "b",
        "f",
        "v",
      ]);
      expect(expandWithForeignKeyNeighbours(after, ["b"])).toContain("f");
    } finally {
      after.close();
    }
  });

  it("ignores a content= that sits inside another option's quoted value", () => {
    const { after } = schemas(
      `CREATE VIRTUAL TABLE f USING fts5(id, tokenize="unicode61 tokenchars 'content=fake'", content='b');`,
    );
    try {
      expect(expandWithForeignKeyNeighbours(after, ["b"])).toEqual(["b", "f"]);
    } finally {
      after.close();
    }
  });

  it.each([
    ["content='b'", "b"],
    ['content="b"', "b"],
    ["content=`b`", "b"],
    ["content=[b]", "b"],
    ["content=b", "b"],
    ["content = 'b'", "b"],
  ])("reads a content option written as %s", (option, table) => {
    const { after } = schemas(
      `CREATE VIRTUAL TABLE f USING fts5(id, ${option});`,
    );
    try {
      expect(expandWithForeignKeyNeighbours(after, [table])).toEqual([
        "b",
        "f",
      ]);
    } finally {
      after.close();
    }
  });

  it.each([
    [
      "CREATE VIRTUAL /* x */ TABLE f -- y\n USING /* z */ fts5 /* w */ (id, content='b')",
    ],
    ["CREATE VIRTUAL TABLE f USING \"fts5\"(id, content='b')"],
    ["CREATE VIRTUAL TABLE f USING `fts5`(id, content='b')"],
    ["CREATE VIRTUAL TABLE f USING [fts5](id, content='b')"],
    ["CREATE VIRTUAL TABLE f USING fts5(id, /* ) */ content='b' /* , */)"],
  ])("reads the module of %s", (sql) => {
    const { after } = schemas(sql);
    try {
      expect(expandWithForeignKeyNeighbours(after, ["b"])).toEqual(["b", "f"]);
    } finally {
      after.close();
    }
  });

  it("decodes only the delimiter's own escape in a content option", () => {
    const { after } = schemas(
      `CREATE TABLE "b''c"(id); CREATE VIRTUAL TABLE f USING fts5(id, content="b''c");`,
    );
    try {
      expect(expandWithForeignKeyNeighbours(after, ["b''c"])).toEqual([
        "b''c",
        "f",
      ]);
    } finally {
      after.close();
    }
  });

  it("does not read a module from inside a quoted table name", () => {
    const { after } = schemas(
      `CREATE VIRTUAL TABLE "x USING fts5(content='b')" USING fts5(id);`,
    );
    try {
      expect(expandWithForeignKeyNeighbours(after, ["b"])).toEqual(["b"]);
    } finally {
      after.close();
    }
  });

  it("follows full-text content tables through views to the base table", () => {
    const { after } = schemas(
      `CREATE VIEW vb2 AS SELECT id FROM b;
       CREATE VIRTUAL TABLE f2 USING fts5(id, content='vb2');
       CREATE VIEW vb1 AS SELECT id FROM f2;
       CREATE VIRTUAL TABLE f1 USING fts5(id, content='vb1');
       CREATE VIEW v AS SELECT id FROM f1;`,
    );
    try {
      expect(expandWithForeignKeyNeighbours(after, ["b"])).toEqual([
        "b",
        "f1",
        "f2",
        "v",
        "vb1",
        "vb2",
      ]);
      expect(expandWithForeignKeyNeighbours(after, ["v"])).toContain("b");
    } finally {
      after.close();
    }
  });

  it("follows a full-text content view to the table under it", () => {
    const { after } = schemas(
      "CREATE VIEW v1 AS SELECT * FROM b; CREATE VIRTUAL TABLE f USING fts5(id, content='v1');",
    );
    try {
      expect(expandWithForeignKeyNeighbours(after, ["b"])).toContain("f");
    } finally {
      after.close();
    }
  });

  it("does not treat a contentless full-text table as depending on a table", () => {
    const { after } = schemas(
      "CREATE VIRTUAL TABLE f USING fts5(id, content='');",
    );
    try {
      expect(expandWithForeignKeyNeighbours(after, ["f"])).toEqual(["f"]);
    } finally {
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
    "CREATE TEMP TABLE b (id); ALTER TABLE b RENAME TO c; ALTER TABLE c ADD COLUMN x;",
  ])("keeps a temp table's later statements out of main: %s", (sql) => {
    expect(scanRebuiltTables(sql)).toEqual([]);
  });

  it.each([
    ["CREATE TEMP TABLE b(id); DROP TABLE temp.b; DROP TABLE b;", ["b"]],
    ["CREATE TABLE temp.b(id); DROP TABLE b;", []],
    ["CREATE TEMPORARY TABLE temp.x(id); DROP TABLE x;", []],
    [
      "CREATE TEMP TABLE t(id); ALTER TABLE temp.t RENAME TO b; DROP TABLE b;",
      [],
    ],
    [
      "CREATE TEMP TABLE b(id); ALTER TABLE temp.b RENAME TO c; DROP TABLE b;",
      ["b"],
    ],
    [
      "CREATE TEMP TABLE threads(x); DROP TABLE temp.threads; ALTER TABLE threads ADD COLUMN r;",
      ["threads"],
    ],
  ])("tracks a qualified temp name consistently: %s", (sql, expected) => {
    expect(scanRebuiltTables(sql)).toEqual(expected);
  });

  it.each([
    [
      "SAVEPOINT s; CREATE TEMP TABLE b(id); ROLLBACK TO s; RELEASE s; DROP TABLE b;",
      ["b"],
    ],
    ["CREATE TEMP TABLE __new_b(id); CREATE TABLE __new_b(id);", ["b"]],
  ])("handles rolled back and shadowed temp names: %s", (sql, expected) => {
    expect(scanRebuiltTables(sql)).toEqual(expected);
  });

  it.each([
    [
      "CREATE TEMP VIEW b AS SELECT 1; CREATE TEMP TABLE IF NOT EXISTS b(id); DROP VIEW b; DROP TABLE b;",
      ["b"],
    ],
    [
      "CREATE TEMP TABLE b(id); SAVEPOINT s; ROLLBACK TO s; RELEASE s; DROP TABLE b;",
      ["b"],
    ],
  ])("fails closed when temp tracking is uncertain: %s", (sql, expected) => {
    expect(scanRebuiltTables(sql)).toEqual(expected);
  });

  it.each([
    ["EXPLAIN CREATE TEMP TABLE b(id); DROP TABLE b;", ["b"]],
    ["EXPLAIN QUERY PLAN CREATE TEMP TABLE b(id); DROP TABLE b;", ["b"]],
    ["EXPLAIN DROP TABLE b;", ["b"]],
    ["CREATE TEMP TABLE b(id); EXPLAIN DROP TABLE b; DROP TABLE b;", []],
  ])("ignores EXPLAIN statements for temp tracking: %s", (sql, expected) => {
    expect(scanRebuiltTables(sql)).toEqual(expected);
  });

  it("treats only SQLite whitespace as whitespace", () => {
    expect(
      scanRebuiltTables(
        "CREATE TEMP TABLE \u00a0queued_thread_messages(id); DROP TABLE queued_thread_messages;",
      ),
    ).toEqual(["queued_thread_messages"]);
  });

  it("folds only ASCII letters in names", () => {
    expect(
      scanRebuiltTables('CREATE TEMP TABLE "\u00c4"(id); DROP TABLE "\u00e4";'),
    ).toEqual(["\u00e4"]);
    expect(
      scanRebuiltTables('CREATE TEMP TABLE "B"(id); DROP TABLE "b";'),
    ).toEqual([]);
  });

  describe("against real SQLite separators", () => {
    const REFUSED = /[\u0000-\u0008\u000e-\u001f\u007f]/;
    const separators = [
      ...Array.from({ length: 0x21 }, (_, code) => code),
      0x7f,
      0x85,
      0xa0,
      0x200b,
      0x2028,
      0x2029,
      0xfeff,
    ].map((code) => String.fromCodePoint(code));
    const placements: Array<[string, (c: string) => string]> = [
      ["glued", (c) => `DROP TABLE${c}b;`],
      ["leading", (c) => `DROP TABLE ${c}b;`],
      ["trailing", (c) => `DROP TABLE b${c};`],
      ["doubled", (c) => `DROP TABLE ${c}${c}b;`],
    ];

    it("flags b exactly when SQLite drops b", () => {
      const checked: string[] = [];
      for (const separator of separators) {
        for (const [placement, build] of placements) {
          const sql = build(separator);
          const db = new Database(":memory:");
          try {
            db.exec("CREATE TABLE b(id);");
            let executed = true;
            try {
              db.exec(sql);
            } catch {
              executed = false;
            }
            if (!executed) continue;
            if (REFUSED.test(separator)) {
              expect(() => scanRebuiltTables(sql)).toThrow(/control character/);
              continue;
            }
            const dropped =
              db
                .prepare("SELECT 1 FROM sqlite_master WHERE name = 'b'")
                .get() === undefined;
            const flagged = scanRebuiltTables(sql).includes("b");
            if (flagged !== dropped) {
              checked.push(
                `${placement} U+${separator.codePointAt(0)?.toString(16)}: sqlite dropped=${dropped} scanner flagged=${flagged}`,
              );
            }
          } finally {
            db.close();
          }
        }
      }
      expect(checked).toEqual([]);
    });

    it("sees an FTS content table exactly when SQLite does", () => {
      const mismatches: string[] = [];
      for (const separator of separators) {
        for (const placement of ["glued", "leading", "doubled"]) {
          const lead =
            placement === "glued"
              ? separator
              : placement === "leading"
                ? ` ${separator}`
                : ` ${separator}${separator}`;
          const sql = `CREATE VIRTUAL TABLE f USING fts5(id,${lead}content='b');`;
          const { after } = (() => {
            const database = new Database(":memory:");
            database.exec("CREATE TABLE b(id);");
            return { after: database };
          })();
          try {
            try {
              after.exec(sql);
            } catch {
              continue;
            }
            const external =
              after
                .prepare("SELECT 1 FROM sqlite_master WHERE name = 'f_content'")
                .get() === undefined;
            const seen = expandWithForeignKeyNeighbours(after, ["b"]).includes(
              "f",
            );
            if (seen !== external) {
              mismatches.push(
                `${placement} U+${separator.codePointAt(0)?.toString(16)}: external=${external} seen=${seen}`,
              );
            }
          } finally {
            after.close();
          }
        }
      }
      expect(mismatches).toEqual([]);
    });
  });

  it("scans every real upstream and Aleph step without refusing it", () => {
    const input = loadMigrationPlanInput(sourceFolders);
    for (const step of input.upstream) {
      expect(() => scanRebuiltTables(readUpstreamSql(step.tag))).not.toThrow();
    }
    for (const step of input.aleph) {
      expect(() =>
        scanRebuiltTables(
          readFileSync(join(sourceFolders.alephFolder, step.file), "utf8"),
        ),
      ).not.toThrow();
    }
  });

  it("refuses the NUL repro instead of reading past it", () => {
    expect(() =>
      scanRebuiltTables(
        "SELECT 1;\u0000 CREATE TEMP TABLE b(id);\n--> statement-breakpoint\nDROP TABLE b;",
      ),
    ).toThrow(/U\+0000 at offset 9/);
  });

  it.each([
    ["a C0 control character", "\u0001"],
    ["BEL", "\u0007"],
    ["backspace", "\u0008"],
    ["shift out", "\u000e"],
    ["escape", "\u001b"],
    ["unit separator", "\u001f"],
    ["delete", "\u007f"],
  ])("refuses %s anywhere in the SQL", (_label, character) => {
    for (const sql of [
      `DROP TABLE b${character};`,
      `SELECT '${character}';`,
      `-- ${character}\nDROP TABLE b;`,
    ]) {
      expect(() => scanRebuiltTables(sql)).toThrow(MigrationGuardError);
    }
  });

  it.each(["\t", "\n", "\f", "\r", "\u000b"])(
    "accepts the modelled whitespace %j",
    (character) => {
      expect(() =>
        scanRebuiltTables(`DROP TABLE ${character}b;`),
      ).not.toThrow();
    },
  );

  it("does not let EXPLAIN leak across a statement breakpoint", () => {
    expect(
      scanRebuiltTables(
        "CREATE TEMP TABLE a(x);\nALTER TABLE t ADD c text DEFAULT explain\n--> statement-breakpoint\nDROP TABLE a\n--> statement-breakpoint\nDROP TABLE a;",
      ),
    ).toEqual(["a", "t"]);
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
        readAlephSql,
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
        readAlephSql,
        readUpstreamSql: sqlFor,
      }),
    ).toThrow(/0144_synthetic rebuilds or alters queued_thread_messages/);
  });

  it.each([
    ["a trailing NBSP", "DROP TABLE queued_thread_messages\u00a0"],
    ["a leading U+2028", "\u2028DROP TABLE queued_thread_messages"],
    ["a trailing BOM", "DROP TABLE queued_thread_messages\ufeff"],
    [
      "a trailing NBSP after a breakpoint",
      "SELECT 1;\n--> statement-breakpoint\nDROP TABLE queued_thread_messages\u00a0",
    ],
  ])("refuses a drop of a guarded table hidden by %s", (_label, sql) => {
    const { input, sqlFor } = withNewUpstreamStep(sql);
    expect(() =>
      guardPlan({
        frozen,
        input,
        plan: buildMigrationPlan(input),
        guardedTables: guardedTables(),
        readAlephSql,
        readUpstreamSql: sqlFor,
      }),
    ).toThrow(/0144_synthetic rebuilds or alters queued_thread_messages/);
  });

  it("scans the same trimmed text the executor runs", () => {
    for (const sql of [
      "DROP TABLE queued_thread_messages\u00a0",
      "\u2028DROP TABLE queued_thread_messages",
      "DROP TABLE queued_thread_messages\ufeff",
    ]) {
      expect(scanRebuiltTables(sql)).toEqual(["queued_thread_messages"]);
      expect(splitMigrationStatements(sql)).toEqual([
        "DROP TABLE queued_thread_messages",
      ]);
    }
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
        readAlephSql,
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
          readAlephSql,
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
        readAlephSql,
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
        readAlephSql,
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

    function guardInput(
      input: MigrationPlanInput,
      sql = "SELECT 1;",
      newAlephSql = "SELECT 1;",
    ): void {
      guardPlan({
        frozen,
        input,
        plan: buildMigrationPlan(input),
        guardedTables: guardedTables(),
        readAlephSql: (id) =>
          alephFileById.has(id) ? readAlephSql(id) : newAlephSql,
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
          readAlephSql,
          readUpstreamSql: sqlFor,
        }),
      ).toThrow(/0144_synthetic has when \d+, which is not after/);
    });

    it("refuses a control character in a new Aleph step", () => {
      const input = extend([], [alephStep("A0010", "A0009", lastWhen + 1)]);
      expect(() =>
        guardInput(
          input,
          "SELECT 1;",
          "SELECT 1;\u0000 CREATE TABLE intended_new_table(id);",
        ),
      ).toThrow(/Aleph step A0010: .*U\+0000 at offset 9/);
    });

    it("accepts a new Aleph step without control characters", () => {
      const input = extend([], [alephStep("A0010", "A0009", lastWhen + 1)]);
      expect(() =>
        guardInput(input, "SELECT 1;", "CREATE TABLE intended_new_table(id);"),
      ).not.toThrow();
    });

    it("accepts a when one after the newest earlier step", () => {
      const { input, sqlFor } = withNewUpstreamStep("SELECT 1;", lastWhen + 1);
      expect(() =>
        guardPlan({
          frozen,
          input,
          plan: buildMigrationPlan(input),
          guardedTables: guardedTables(),
          readAlephSql,
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
          readAlephSql,
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
          readAlephSql,
          readUpstreamSql: sqlFor,
        }),
      ).toThrow(/0144_synthetic is not in the migration plan/);
    });
  });
});
