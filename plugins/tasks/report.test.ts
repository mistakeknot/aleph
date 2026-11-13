import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { createTasksStore } from "./db";
import plugin from "./server";

describe("task reports", () => {
  it("upgrades existing rows from version 8 without changing their data", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "tasks" });
    const db = bb.storage.database();
    const store = createTasksStore(db);
    const project = store.createProject({
      name: "Reports",
      prefix: "RPT",
      color: "blue",
    });
    const task = store.createTask({
      projectId: project.id,
      title: "Existing",
      description: "The ask",
      status: "done",
    });
    if (
      db
        .prepare(
          "SELECT name FROM pragma_table_info('tasks') WHERE name = 'report'",
        )
        .get()
    ) {
      db.exec("ALTER TABLE tasks DROP COLUMN report");
    }
    db.exec("DELETE FROM schema_version WHERE version > 8");
    db.exec("ALTER TABLE tasks DROP COLUMN return_at");
    db.exec("ALTER TABLE tasks DROP COLUMN return_thread_id");
    const before = db
      .prepare<[], Record<string, unknown>>("SELECT * FROM tasks")
      .all();
    try {
      const migrated = createTasksStore(db);
      expect(migrated.getTask(task.id)).toMatchObject({
        description: "The ask",
        report: null,
        status: "done",
      });
      expect(db.prepare("SELECT * FROM tasks").all()).toEqual(
        before.map((row) => ({
          ...row,
          report: null,
          return_at: null,
          return_thread_id: null,
        })),
      );
      expect(createTasksStore(db).getTask(task.id)).toEqual(
        migrated.getTask(task.id),
      );
      expect(
        migrated.updateTask(task.id, { title: "Still writable" }),
      ).toMatchObject({ report: null, description: "The ask" });
    } finally {
      await harness.dispose();
    }
  });

  it("sets, replaces and clears reports through RPC without replacing the ask", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "tasks" });
    await plugin(bb);
    const store = createTasksStore(bb.storage.database());
    const project = store.createProject({
      name: "Reports",
      prefix: "RPT",
      color: "blue",
    });
    try {
      const result = await harness.callRpc("createTask", {
        projectId: project.id,
        title: "RPC",
        description: "The ask",
        report: "First",
      });
      expect(result).toMatchObject({ ok: true, task: { report: "First" } });
      const task = store.listTasks({ projectId: project.id })[0];
      for (const report of ["Updated", "", null]) {
        expect(
          await harness.callRpc("updateTask", { taskId: task.id, report }),
        ).toMatchObject({ ok: true, task: { report, description: "The ask" } });
      }
    } finally {
      await harness.dispose();
    }
  });

  it("sets, replaces and clears reports through the CLI", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "tasks" });
    await plugin(bb);
    const store = createTasksStore(bb.storage.database());
    const project = store.createProject({
      name: "Reports",
      prefix: "RPT",
      color: "blue",
    });
    try {
      expect(
        (
          await harness.runCli([
            "create",
            "--project",
            project.prefix,
            "--title",
            "CLI",
            "--report",
            "First",
          ])
        ).exitCode,
      ).toBe(0);
      const task = store.listTasks({ projectId: project.id })[0];
      expect(task.report).toBe("First");
      for (const report of ["Updated", ""]) {
        expect(
          (await harness.runCli(["update", task.key, "--report", report]))
            .exitCode,
        ).toBe(0);
        expect(store.getTask(task.id)?.report).toBe(report);
      }
    } finally {
      await harness.dispose();
    }
  });
});
