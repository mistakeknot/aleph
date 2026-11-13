import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { createTasksStore } from "./db";

describe("task return storage migration", () => {
  it("upgrades version 9 rows without changing existing task reads or writes", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "tasks" });
    const db = bb.storage.database();
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
    for (const name of ["return_at", "return_thread_id"]) {
      if (
        db
          .prepare("SELECT name FROM pragma_table_info('tasks') WHERE name = ?")
          .get(name)
      ) {
        db.exec(`ALTER TABLE tasks DROP COLUMN ${name}`);
      }
    }
    db.exec("DELETE FROM schema_version WHERE version > 9");
    const before = db
      .prepare<[], Record<string, unknown>>("SELECT * FROM tasks")
      .all();
    try {
      const migrated = createTasksStore(db);
      expect(db.prepare("SELECT * FROM tasks").all()).toEqual(
        before.map((row) => ({
          ...row,
          return_at: null,
          return_thread_id: null,
        })),
      );
      expect(migrated.getTask(task.id)).toEqual(task);
      expect(migrated.updateTask(task.id, { title: "Updated" })).toEqual({
        ...task,
        title: "Updated",
        updatedAt: expect.any(String),
      });
      expect(createTasksStore(db).getTask(task.id)).toEqual(
        migrated.getTask(task.id),
      );
    } finally {
      await harness.dispose();
    }
  });

  it("initializes nullable text return fields on a fresh database", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "tasks" });
    const db = bb.storage.database();
    try {
      const store = createTasksStore(db);
      const project = store.createProject({
        name: "Work",
        prefix: "WRK",
        color: "blue",
      });
      const task = store.createTask({ projectId: project.id, title: "Fresh" });
      expect(
        db
          .prepare("SELECT return_at, return_thread_id FROM tasks WHERE id = ?")
          .get(task.id),
      ).toEqual({ return_at: null, return_thread_id: null });
      db.prepare(
        "UPDATE tasks SET return_at = ?, return_thread_id = ? WHERE id = ?",
      ).run("2026-12-01T14:00:00.000Z", "thr_example", task.id);
      expect(
        db
          .prepare("SELECT return_at, return_thread_id FROM tasks WHERE id = ?")
          .get(task.id),
      ).toEqual({
        return_at: "2026-12-01T14:00:00.000Z",
        return_thread_id: "thr_example",
      });
    } finally {
      await harness.dispose();
    }
  });
});
