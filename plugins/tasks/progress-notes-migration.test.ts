import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { createTasksStore } from "./db";

function setup() {
  const { bb, harness } = createFakePluginHost({ pluginId: "tasks" });
  return { db: bb.storage.database(), harness };
}

function insertNote(
  db: ReturnType<typeof setup>["db"],
  id: string,
  taskId: string,
  threadId: string | null,
  createdAt = "2026-12-01T14:00:00.000Z",
) {
  db.prepare(
    `INSERT INTO progress_notes (
      id, task_id, author_name, preset_name, thread_id, body, proof_url, created_at
    ) VALUES (?, ?, 'Agent', NULL, ?, 'Step done', NULL, ?)`,
  ).run(id, taskId, threadId, createdAt);
}

describe("task progress notes storage migration", () => {
  it("upgrades version 10 databases without changing existing rows", async () => {
    const { db, harness } = setup();
    try {
      const store = createTasksStore(db);
      const project = store.createProject({
        name: "Work",
        prefix: "WRK",
        color: "blue",
      });
      const task = store.createTask({
        projectId: project.id,
        title: "Existing",
        report: "Result",
      });
      db.exec("DROP TABLE progress_notes");
      db.exec("DELETE FROM schema_version WHERE version > 10");
      for (const kind of ["user", "agent", "system"] as const) {
        store.createComment({
          taskId: task.id,
          kind,
          authorName: "Existing author",
          threadId: kind === "agent" ? "thr_existing" : null,
          body: `Existing ${kind} entry`,
        });
      }
      const tables = [
        "projects",
        "tasks",
        "comments",
        "task_threads",
        "presets",
      ];
      const before = tables.map((table) =>
        db.prepare<[], Record<string, unknown>>(`SELECT * FROM ${table}`).all(),
      );
      const commentsSql = db
        .prepare<[], { sql: string }>(
          "SELECT sql FROM sqlite_master WHERE name = 'comments'",
        )
        .get()?.sql;

      const migrated = createTasksStore(db);

      expect(
        tables.map((table) =>
          db
            .prepare<[], Record<string, unknown>>(`SELECT * FROM ${table}`)
            .all(),
        ),
      ).toEqual(before);
      expect(
        db
          .prepare<[], { sql: string }>(
            "SELECT sql FROM sqlite_master WHERE name = 'comments'",
          )
          .get()?.sql,
      ).toBe(commentsSql);
      expect(migrated.getTask(task.id)).toEqual(task);
      expect(
        db.prepare("SELECT COUNT(*) AS count FROM progress_notes").get(),
      ).toEqual({ count: 0 });
      expect(
        db
          .prepare<[], { version: number }>(
            "SELECT MAX(version) AS version FROM schema_version",
          )
          .get()?.version,
      ).toBe(11);
    } finally {
      await harness.dispose();
    }
  });

  it("is idempotent and keeps notes across repeated initialization", async () => {
    const { db, harness } = setup();
    try {
      const store = createTasksStore(db);
      const project = store.createProject({
        name: "Work",
        prefix: "WRK",
        color: "blue",
      });
      const task = store.createTask({ projectId: project.id, title: "Task" });
      insertNote(db, "note_1", task.id, "thr_example");
      db.exec("DELETE FROM schema_version WHERE version = 11");

      createTasksStore(db);
      createTasksStore(db);

      expect(
        db.prepare("SELECT id, thread_id FROM progress_notes").all(),
      ).toEqual([{ id: "note_1", thread_id: "thr_example" }]);
      expect(
        db
          .prepare<[], { count: number }>(
            "SELECT COUNT(*) AS count FROM schema_version",
          )
          .get()?.count,
      ).toBe(11);
    } finally {
      await harness.dispose();
    }
  });

  it("cascades with the task and rejects orphan or malformed notes", async () => {
    const { db, harness } = setup();
    try {
      const store = createTasksStore(db);
      const project = store.createProject({
        name: "Work",
        prefix: "WRK",
        color: "blue",
      });
      const task = store.createTask({ projectId: project.id, title: "Task" });
      const other = store.createTask({ projectId: project.id, title: "Other" });

      expect(() => insertNote(db, "note_orphan", "missing", null)).toThrow(
        /FOREIGN KEY/,
      );
      expect(() => insertNote(db, "note_bad", task.id, "abc")).toThrow(/CHECK/);
      insertNote(db, "note_1", task.id, null);
      insertNote(db, "note_2", other.id, "thr_example");

      db.prepare("DELETE FROM tasks WHERE id = ?").run(task.id);

      expect(db.prepare("SELECT id FROM progress_notes").all()).toEqual([
        { id: "note_2" },
      ]);
    } finally {
      await harness.dispose();
    }
  });

  it("creates the task ordering index and uses it for task reads", async () => {
    const { db, harness } = setup();
    try {
      createTasksStore(db);
      expect(
        db
          .prepare<[], { name: string }>(
            "SELECT name FROM pragma_index_info('idx_progress_notes_task_order')",
          )
          .all()
          .map((column) => column.name),
      ).toEqual(["task_id", "created_at", "id"]);
      const plan = db
        .prepare<[string], { detail: string }>(
          "EXPLAIN QUERY PLAN SELECT id FROM progress_notes WHERE task_id = ? ORDER BY created_at, id",
        )
        .all("task");
      expect(plan.map((step) => step.detail).join("\n")).toContain(
        "idx_progress_notes_task_order",
      );
    } finally {
      await harness.dispose();
    }
  });
});
