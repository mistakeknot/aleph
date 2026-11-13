import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  invalidateComments,
  invalidateTaskChanged,
  type TasksApiStore,
} from "./api";
import { errorMessage, sdkErrorCode } from "./shared/errors";

const DELIVERY_RETRY_WINDOW_MS = 24 * 60 * 60 * 1000;

interface PendingReturn {
  id: string;
  return_at: string;
  return_thread_id: string;
}

export async function registerReturns(
  bb: BbPluginApi,
  store: TasksApiStore,
): Promise<void> {
  const db = bb.storage.database();
  let running: Promise<void> | null = null;
  function finish(row: PendingReturn, body: string, delivered = false): void {
    const task = store.transaction(() => {
      const current = store.tasks.getTask(row.id);
      if (!current) return undefined;
      const result = db
        .prepare(
          "UPDATE tasks SET return_at = NULL, return_thread_id = NULL WHERE id = ? AND return_at = ? AND return_thread_id = ?",
        )
        .run(row.id, row.return_at, row.return_thread_id);
      if (result.changes === 0 && !delivered) return undefined;
      store.tasks.createComment({
        taskId: row.id,
        kind: "system",
        authorName: "Tasks",
        body,
      });
      return current;
    });
    if (task) {
      invalidateTaskChanged(bb, task);
      invalidateComments(bb, task.id);
    }
  }
  function failed(row: PendingReturn, error: unknown): void {
    bb.log.warn(`Task return delivery failed: ${errorMessage(error)}`);
    if (Date.now() - Date.parse(row.return_at) >= DELIVERY_RETRY_WINDOW_MS) {
      finish(row, "return time missed: delivery failed");
    }
  }
  async function sweep(): Promise<void> {
    const rows = db
      .prepare<[string], PendingReturn>(
        "SELECT id, return_at, return_thread_id FROM tasks WHERE return_at IS NOT NULL AND return_at <= ? ORDER BY return_at, id",
      )
      .all(new Date().toISOString());
    for (const row of rows) {
      let unavailable = false;
      try {
        const thread = await bb.sdk.threads.get({
          threadId: row.return_thread_id,
        });
        unavailable = thread.archivedAt !== null || thread.deletedAt !== null;
      } catch (error) {
        if (sdkErrorCode(error) === "thread_not_found") {
          finish(row, "return time missed: thread unavailable");
        } else {
          failed(row, error);
        }
        continue;
      }
      const task = store.tasks.getTask(row.id);
      if (
        !task ||
        task.returnAt !== row.return_at ||
        task.returnThreadId !== row.return_thread_id
      )
        continue;
      if (task.status === "done" || task.status === "canceled") {
        finish(row, "Return time cancelled: task closed");
      } else if (unavailable) {
        finish(row, "return time missed: thread unavailable");
      } else {
        try {
          await bb.sdk.threads.send({
            wakeCause: "timer",
            wakeRef: `${row.id}:${row.return_at}`,
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
          failed(row, error);
          continue;
        }
        finish(row, "Return time fired", true);
      }
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
