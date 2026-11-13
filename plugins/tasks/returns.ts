import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  invalidateComments,
  invalidateTaskChanged,
  type TasksApiStore,
} from "./api";
import { errorMessage } from "./shared/errors";

export async function registerReturns(
  bb: BbPluginApi,
  store: TasksApiStore,
): Promise<void> {
  const db = bb.storage.database();
  let running: Promise<void> | null = null;
  async function sweep(): Promise<void> {
    const rows = db
      .prepare<
        [string],
        { id: string; return_at: string; return_thread_id: string }
      >(
        "SELECT id, return_at, return_thread_id FROM tasks WHERE return_at IS NOT NULL AND return_at <= ? ORDER BY return_at, id",
      )
      .all(new Date().toISOString());
    for (const row of rows) {
      const task = store.tasks.getTask(row.id);
      if (!task) continue;
      let unavailable = false;
      try {
        const thread = await bb.sdk.threads.get({
          threadId: row.return_thread_id,
        });
        unavailable = thread.archivedAt !== null || thread.deletedAt !== null;
      } catch {
        unavailable = true;
      }
      const claimed = store.transaction(() => {
        const result = db
          .prepare(
            "UPDATE tasks SET return_at = NULL, return_thread_id = NULL WHERE id = ? AND return_at = ? AND return_thread_id = ?",
          )
          .run(row.id, row.return_at, row.return_thread_id);
        return result.changes > 0;
      });
      if (!claimed) continue;
      let body = "Return time fired";
      if (task.status === "done" || task.status === "canceled") {
        body = "Return time cancelled: task closed";
      } else if (unavailable) {
        body = "Return time missed: thread unavailable";
      } else {
        try {
          await bb.sdk.threads.send({
            threadId: row.return_thread_id,
            input: [
              {
                type: "text",
                text: `Return time reached for task ${task.key}: ${task.title}. Review the task and continue when appropriate.`,
                mentions: [],
              },
            ],
            mode: "steer-if-active",
          });
        } catch (error) {
          bb.log.warn(`Task return delivery failed: ${errorMessage(error)}`);
          body = "Return time missed: thread unavailable";
        }
      }
      store.tasks.createComment({
        taskId: row.id,
        kind: "system",
        authorName: "Tasks",
        body,
      });
      invalidateTaskChanged(bb, task);
      invalidateComments(bb, task.id);
    }
  }
  function run(): Promise<void> {
    running ??= sweep().finally(() => {
      running = null;
    });
    return running;
  }
  bb.background.schedule("task-returns", "* * * * *", run);
  await run();
}
