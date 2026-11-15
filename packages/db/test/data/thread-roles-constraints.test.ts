import { afterEach, describe, expect, it } from "vitest";
import { createMigratedConnection } from "../../src/testing.js";
import { makeThread, setupRoles } from "../helpers/thread-roles.js";

const open: Array<{ $client: { close(): void } }> = [];
afterEach(() => {
  for (const db of open.splice(0)) db.$client.close();
});

function setup() {
  const ctx = setupRoles();
  open.push(ctx.db);
  return ctx;
}

const insert =
  "INSERT INTO thread_roles (role, thread_id, generation, since, updated_at, updated_by_kind, updated_by_thread_id) VALUES (?, ?, ?, ?, ?, ?, ?)";

function valid(role = "vizier", threadId: string | null = null) {
  return [role, threadId, 1, 1000, 1000, "cli", null] as const;
}

describe("thread_roles constraints", () => {
  it("accepts a valid row", () => {
    const { db } = setup();
    db.$client.prepare(insert).run(...valid());
    expect(db.$client.prepare("SELECT count(*) AS n FROM thread_roles").get()).toEqual({ n: 1 });
  });

  it.each([
    ["empty role", ["", null, 1, 1, 1, "cli", null]],
    ["uppercase role", ["Vizier", null, 1, 1, 1, "cli", null]],
    ["underscore role", ["a_b", null, 1, 1, 1, "cli", null]],
    ["non-ascii role", ["é", null, 1, 1, 1, "cli", null]],
    ["newline role", ["a\nb", null, 1, 1, 1, "cli", null]],
    ["blob role", [Buffer.from("abc"), null, 1, 1, 1, "cli", null]],
    ["zero generation", ["a", null, 0, 1, 1, "cli", null]],
    ["negative generation", ["a", null, -1, 1, 1, "cli", null]],
    ["too-large generation", ["a", null, 9007199254740992, 1, 1, "cli", null]],
    ["fractional generation", ["a", null, 1.5, 1, 1, "cli", null]],
    ["text generation", ["a", null, "abc", 1, 1, "cli", null]],
    ["text since", ["a", null, 1, "abc", 1, "cli", null]],
    ["real updated_at", ["a", null, 1, 1, 1.5, "cli", null]],
    ["blob thread id", ["a", Buffer.from("x"), 1, 1, 1, "cli", null]],
    ["unknown kind", ["a", null, 1, 1, 1, "robot", null]],
    ["null since", ["a", null, 1, null, 1, "cli", null]],
  ])("rejects %s", (_name, values) => {
    const { db } = setup();
    expect(() => db.$client.prepare(insert).run(...values)).toThrow(
      /CHECK constraint|NOT NULL constraint|datatype mismatch/,
    );
  });

  it("rejects an unknown thread id through the foreign key", () => {
    const { db } = setup();
    expect(() =>
      db.$client.prepare(insert).run(...valid("a", "thr_missing")),
    ).toThrow(/FOREIGN KEY/);
  });

  it("rejects a second row for the same role", () => {
    const { db } = setup();
    db.$client.prepare(insert).run(...valid("a"));
    expect(() => db.$client.prepare(insert).run(...valid("a"))).toThrow(
      /UNIQUE|PRIMARY KEY/,
    );
  });

  it("allows one thread to hold several roles", () => {
    const { db, project } = setup();
    const thread = makeThread(db, project.id);
    db.$client.prepare(insert).run(...valid("a", thread.id));
    db.$client.prepare(insert).run(...valid("b", thread.id));
    expect(db.$client.prepare("SELECT count(*) AS n FROM thread_roles").get()).toEqual({ n: 2 });
  });

  it("fires the holder-cleared trigger only for a plain clear", () => {
    const { db, project } = setup();
    const a = makeThread(db, project.id);
    const b = makeThread(db, project.id);
    db.$client.prepare(insert).run(...valid("a", a.id));
    db.$client.prepare("UPDATE thread_roles SET thread_id = ? WHERE role = 'a'").run(b.id);
    expect(db.$client.prepare("SELECT generation FROM thread_roles").get()).toEqual({ generation: 1 });
    db.$client.prepare("UPDATE thread_roles SET thread_id = NULL, generation = 5 WHERE role = 'a'").run();
    expect(db.$client.prepare("SELECT generation FROM thread_roles").get()).toEqual({ generation: 5 });
    db.$client.prepare("UPDATE thread_roles SET thread_id = ?, generation = 6 WHERE role = 'a'").run(b.id);
    db.$client.prepare("UPDATE thread_roles SET thread_id = NULL WHERE role = 'a'").run();
    expect(db.$client.prepare("SELECT generation, updated_by_kind AS kind FROM thread_roles").get()).toEqual({ generation: 7, kind: "system" });
  });

  it("does not re-fire the trigger recursively", () => {
    const { db, project } = setup();
    const a = makeThread(db, project.id);
    db.$client.prepare(insert).run(...valid("a", a.id));
    db.$client.prepare("UPDATE thread_roles SET thread_id = NULL WHERE role = 'a'").run();
    expect(db.$client.prepare("SELECT generation FROM thread_roles").get()).toEqual({ generation: 2 });
  });

  it("runs on a fresh migrated connection with the trigger present", () => {
    const db = createMigratedConnection();
    open.push(db);
    const trigger = db.$client
      .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'thread_roles'")
      .all();
    expect(trigger).toEqual([{ name: "thread_roles_holder_cleared" }]);
  });
});
