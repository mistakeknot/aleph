import {
  createFakePluginHost,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { createTasksStore } from "./db";
import plugin from "./server";

function setup(
  unavailable: "archived" | "gone" | null = null,
  beforeGet?: () => Promise<void>,
) {
  const host = createFakePluginHost({
    pluginId: "tasks",
    sdk: {
      threads: {
        get: async ({ threadId }) => {
          await beforeGet?.();
          if (unavailable === "gone")
            throw Object.assign(new Error("Thread not found"), {
              code: "thread_not_found",
            });
          return makeThreadResponse({
            id: threadId,
            archivedAt: unavailable === "archived" ? 1 : null,
          });
        },
        send: async () => undefined,
      },
    },
  });
  const db = host.bb.storage.database();
  const store = createTasksStore(db);
  const project = store.createProject({
    name: "Work",
    prefix: "WRK",
    color: "blue",
  });
  const task = store.createTask({
    projectId: project.id,
    title: "Review results",
  });
  return { ...host, db, store, task };
}

describe("task return times", () => {
  it.each([null, "in 3h"])(
    "does not fire a return cancelled or replaced during thread lookup (%s)",
    async (replacement) => {
      let entered = () => {};
      let release = () => {};
      const lookup = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const { bb, harness, db, task } = setup(null, async () => {
        entered();
        await gate;
      });
      try {
        await plugin(bb);
        await harness.callRpc("updateTask", {
          taskId: task.id,
          returnAt: "in 2h",
          returnThreadId: "thr_setter",
        });
        db.prepare("UPDATE tasks SET return_at = ? WHERE id = ?").run(
          new Date(Date.now() - 1000).toISOString(),
          task.id,
        );
        const pending = harness.runSchedule("task-returns");
        await lookup;
        await harness.callRpc("updateTask", {
          taskId: task.id,
          returnAt: replacement,
          returnThreadId: "thr_replacement",
        });
        release();
        await pending;
        expect(harness.sdk.callsTo("threads.send")).toHaveLength(0);
      } finally {
        release();
        await harness.dispose();
      }
    },
  );

  it("fires a newly due return once through the existing scheduler", async () => {
    const { bb, harness, db, task, store } = setup();
    try {
      await plugin(bb);
      await harness.callRpc("updateTask", {
        taskId: task.id,
        returnAt: "in 2h",
        returnThreadId: "thr_setter",
      });
      await harness.runSchedule("task-returns");
      expect(harness.sdk.callsTo("threads.send")).toHaveLength(0);
      db.prepare("UPDATE tasks SET return_at = ? WHERE id = ?").run(
        new Date(Date.now() - 1000).toISOString(),
        task.id,
      );
      await Promise.all([
        harness.runSchedule("task-returns"),
        harness.runSchedule("task-returns"),
      ]);
      expect(harness.sdk.callsTo("threads.send")).toHaveLength(1);
      expect(store.listComments(task.id).map((c) => c.body)).toEqual([
        expect.stringMatching(/^Return time set:/),
        "Return time fired",
      ]);
    } finally {
      await harness.dispose();
    }
  });
  it("sets, replaces, cancels and validates bounds through RPC", async () => {
    const { bb, harness, task, store } = setup();
    try {
      await plugin(bb);
      const update = (returnAt: string | null, returnThreadId = "thr_setter") =>
        harness.callRpc("updateTask", {
          taskId: task.id,
          returnAt,
          returnThreadId,
        });
      const at = new Date(Date.now() + 7_200_000).toISOString();
      expect(await update(at)).toMatchObject({
        ok: true,
        task: { returnAt: at, returnThreadId: "thr_setter" },
      });
      expect(await update("in 3h", "thr_replacement")).toMatchObject({
        ok: true,
        task: {
          returnAt: expect.any(String),
          returnThreadId: "thr_replacement",
        },
      });
      expect(await update(null)).toMatchObject({
        ok: true,
        task: { returnAt: null, returnThreadId: null },
      });
      for (const value of [
        "in 30s",
        "in 31d",
        "bad",
        new Date(Date.now() - 1000).toISOString(),
      ]) {
        await expect(update(value)).rejects.toThrow();
      }
      await expect(update("in 2h", "invalid")).rejects.toThrow();
      await expect(
        harness.callRpc("updateTask", { taskId: task.id, returnAt: "in 2h" }),
      ).rejects.toThrow();
      expect(store.listComments(task.id).map((c) => c.body)).toEqual([
        `Return time set: ${at}`,
        expect.stringMatching(/^Return time replaced:/),
        "Return time cancelled",
      ]);
    } finally {
      await harness.dispose();
    }
  });

  it("sets, replaces and cancels through CLI, with explicit setting thread", async () => {
    const { bb, harness, task, store } = setup();
    try {
      await plugin(bb);
      for (const value of [
        "in 2h",
        new Date(Date.now() + 10_800_000).toISOString(),
      ]) {
        expect(
          (
            await harness.runCli([
              "update",
              task.key,
              "--return-at",
              value,
              "--return-thread",
              "thr_cli",
            ])
          ).exitCode,
        ).toBe(0);
      }
      expect(store.getTask(task.id)).toMatchObject({
        returnThreadId: "thr_cli",
      });
      expect(
        (await harness.runCli(["update", task.key, "--no-return"])).exitCode,
      ).toBe(0);
      expect(store.getTask(task.id)).toMatchObject({ returnAt: null });
      for (const value of ["in 30s", "in 31d"]) {
        expect(
          (
            await harness.runCli([
              "update",
              task.key,
              "--return-at",
              value,
              "--return-thread",
              "thr_cli",
            ])
          ).exitCode,
        ).not.toBe(0);
      }
      expect(store.listComments(task.id)).toHaveLength(3);
    } finally {
      await harness.dispose();
    }
  });

  it.each([null, "archived", "gone"] as const)(
    "recovers a due return on startup exactly once (%s)",
    async (unavailable) => {
      const { bb, harness, task, db, store } = setup(unavailable);
      db.prepare(
        "UPDATE tasks SET return_at = ?, return_thread_id = ? WHERE id = ?",
      ).run(new Date(Date.now() - 60_000).toISOString(), "thr_setter", task.id);
      try {
        await plugin(bb);
        await harness.runSchedule("task-returns");
        await harness.runSchedule("task-returns");
        expect(store.getTask(task.id)).toMatchObject({
          returnAt: null,
          returnThreadId: null,
        });
        expect(harness.sdk.callsTo("threads.send")).toHaveLength(
          unavailable ? 0 : 1,
        );
        if (!unavailable)
          expect(harness.sdk.callsTo("threads.send")[0]).toMatchObject([
            {
              wakeCause: "timer",
              wakeRef: expect.any(String),
              threadId: "thr_setter",
              input: [
                { text: expect.stringContaining(`${task.key}: ${task.title}`) },
              ],
            },
          ]);
        expect(store.listComments(task.id).map((c) => c.body)).toEqual([
          unavailable
            ? "return time missed: thread unavailable"
            : "Return time fired",
        ]);
      } finally {
        await harness.dispose();
      }
    },
  );

  it.each(["done", "canceled"] as const)(
    "closing as %s cancels the return without waking",
    async (status) => {
      const { bb, harness, task, db, store } = setup();
      try {
        await plugin(bb);
        await harness.callRpc("updateTask", {
          taskId: task.id,
          returnAt: "in 2h",
          returnThreadId: "thr_setter",
        });
        await harness.callRpc("updateTask", { taskId: task.id, status });
        await harness.runSchedule("task-returns");
        expect(store.getTask(task.id)).toMatchObject({
          returnAt: null,
          returnThreadId: null,
        });
        expect(
          db.prepare("SELECT return_at FROM tasks WHERE id = ?").get(task.id),
        ).toEqual({ return_at: null });
        expect(harness.sdk.callsTo("threads.send")).toHaveLength(0);
        expect(store.listComments(task.id).map((c) => c.body)).toContain(
          "Return time cancelled: task closed",
        );
      } finally {
        await harness.dispose();
      }
    },
  );
});
