import {
  createFakePluginHost,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { createTasksStore } from "./db";
import plugin from "./server";

function setup(operation: "get" | "send", hoursOverdue = 1) {
  let failing = true;
  const host = createFakePluginHost({
    pluginId: "tasks",
    sdk: {
      threads: {
        get: async ({ threadId }) => {
          if (operation === "get" && failing)
            throw Object.assign(new Error("Temporary outage"), {
              code: "temporarily_unavailable",
            });
          return makeThreadResponse({ id: threadId });
        },
        send: async () => {
          if (operation === "send" && failing)
            throw new Error("Temporary outage");
        },
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
    title: "Retry delivery",
  });
  const at = new Date(Date.now() - hoursOverdue * 3_600_000).toISOString();
  db.prepare(
    "UPDATE tasks SET return_at = ?, return_thread_id = ? WHERE id = ?",
  ).run(at, "thr_setter", task.id);
  return {
    ...host,
    store,
    task,
    at,
    recover: () => {
      failing = false;
    },
  };
}

describe("return delivery retries", () => {
  it("delivers an overdue return after extended downtime when delivery works", async () => {
    const { bb, harness, store, task, recover } = setup("send", 48);
    recover();
    try {
      await plugin(bb);
      expect(store.getTask(task.id)?.returnAt).toBeNull();
      expect(harness.sdk.callsTo("threads.send")).toHaveLength(1);
      expect(store.listComments(task.id).map((c) => c.body)).toEqual([
        "Return time fired",
      ]);
    } finally {
      await harness.dispose();
    }
  });
  it.each(["get", "send"] as const)(
    "retries transient %s failures on the next tick",
    async (operation) => {
      const { bb, harness, store, task, at, recover } = setup(operation);
      try {
        await plugin(bb);
        expect(store.getTask(task.id)).toMatchObject({
          returnAt: at,
          returnThreadId: "thr_setter",
        });
        expect(store.listComments(task.id)).toHaveLength(0);
        recover();
        await harness.runSchedule("task-returns");
        await harness.runSchedule("task-returns");
        expect(store.getTask(task.id)).toMatchObject({
          returnAt: null,
          returnThreadId: null,
        });
        expect(store.listComments(task.id).map((c) => c.body)).toEqual([
          "Return time fired",
        ]);
        expect(harness.sdk.callsTo("threads.send")).toHaveLength(
          operation === "get" ? 1 : 2,
        );
      } finally {
        await harness.dispose();
      }
    },
  );

  it.each(["get", "send"] as const)(
    "stops %s errors after the 24-hour delivery window",
    async (operation) => {
      const { bb, harness, store, task } = setup(operation, 25);
      try {
        await plugin(bb);
        await harness.runSchedule("task-returns");
        expect(store.getTask(task.id)).toMatchObject({
          returnAt: null,
          returnThreadId: null,
        });
        expect(store.listComments(task.id).map((c) => c.body)).toEqual([
          "return time missed: delivery failed",
        ]);
        expect(harness.sdk.callsTo(`threads.${operation}`)).toHaveLength(1);
      } finally {
        await harness.dispose();
      }
    },
  );

  it.each([null, "in 3h"])(
    "preserves cancellation or replacement during a send (%s)",
    async (replacement) => {
      let entered = () => {};
      let release = () => {};
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const { bb, harness } = createFakePluginHost({
        pluginId: "tasks",
        sdk: {
          threads: {
            get: async ({ threadId }) => makeThreadResponse({ id: threadId }),
            send: async () => {
              entered();
              await gate;
            },
          },
        },
      });
      const db = bb.storage.database();
      const store = createTasksStore(db);
      const project = store.createProject({
        name: "Work",
        prefix: "WRK",
        color: "blue",
      });
      const task = store.createTask({ projectId: project.id, title: "Race" });
      let pending = Promise.resolve();
      try {
        await plugin(bb);
        const at = new Date(Date.now() - 1000).toISOString();
        db.prepare(
          "UPDATE tasks SET return_at = ?, return_thread_id = ? WHERE id = ?",
        ).run(at, "thr_setter", task.id);
        pending = harness.runSchedule("task-returns");
        await started;
        expect(store.getTask(task.id)?.returnAt).toBe(at);
        await harness.callRpc("updateTask", {
          taskId: task.id,
          returnAt: replacement,
          returnThreadId: "thr_replacement",
        });
        const updated = store.getTask(task.id);
        release();
        await pending;
        expect(store.getTask(task.id)).toEqual(updated);
        expect(store.listComments(task.id).map((c) => c.body)).toContain(
          "Return time fired",
        );
      } finally {
        release();
        await pending;
        await harness.dispose();
      }
    },
  );

  it.each(["done", "canceled"] as const)(
    "board close to %s clears return permanently",
    async (status) => {
      const { bb, harness, store, task } = setup("get");
      try {
        await plugin(bb);
        await harness.callRpc("updateTask", {
          taskId: task.id,
          returnAt: "in 2h",
          returnThreadId: "thr_setter",
        });
        await harness.callRpc("boardMove", { taskId: task.id, status });
        expect(store.getTask(task.id)).toMatchObject({
          returnAt: null,
          returnThreadId: null,
        });
        expect(store.listComments(task.id).map((c) => c.body)).toContain(
          "Return time cancelled: task closed",
        );
        await harness.callRpc("boardMove", { taskId: task.id, status: "todo" });
        await harness.runSchedule("task-returns");
        expect(store.getTask(task.id)?.returnAt).toBeNull();
        expect(harness.sdk.callsTo("threads.send")).toHaveLength(0);
      } finally {
        await harness.dispose();
      }
    },
  );
});
