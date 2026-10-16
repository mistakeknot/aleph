import type {
  ExperimentalPluginCommandPaletteSearchContext,
  ExperimentalPluginCommandPaletteSearchResult,
} from "@get-bb/plugin-sdk/app";
import { type Task, tasksRpcContract } from "../shared/contract.js";
import { STATUS_LABELS } from "../views/list/lib.js";
import { tasksRouteToSubPath } from "./routes.js";

export const TASKS_PALETTE_RESULT_LIMIT = 8;
const TASKS_PALETTE_MIN_QUERY_LENGTH = 2;
const TASK_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9]{0,9}-\d+$/;

function paletteResult(
  task: Task,
): ExperimentalPluginCommandPaletteSearchResult {
  return {
    id: task.id,
    title: `${task.key} ${task.title}`,
    detail: STATUS_LABELS[task.status],
    open: {
      panelPath: "tasks",
      subPath: tasksRouteToSubPath({ kind: "task", taskKey: task.key }),
    },
  };
}

export async function searchTasksForPalette(
  query: string,
  context: ExperimentalPluginCommandPaletteSearchContext,
): Promise<ExperimentalPluginCommandPaletteSearchResult[]> {
  const search = query.trim();
  if (search.length < TASKS_PALETTE_MIN_QUERY_LENGTH) return [];
  const [exact, listed] = await Promise.all([
    TASK_KEY_PATTERN.test(search)
      ? context.rpc
          .call("getTaskByKey", { taskKey: search.toUpperCase() })
          .then((output) => tasksRpcContract.getTaskByKey.output.parse(output))
      : Promise.resolve({ task: null }),
    context.rpc
      .call("listTasks", {
        search,
        activeOnly: false,
        limit: TASKS_PALETTE_RESULT_LIMIT,
      })
      .then((output) => tasksRpcContract.listTasks.output.parse(output)),
  ]);
  const tasks =
    exact.task === null ? listed.tasks : [exact.task, ...listed.tasks];
  const seen = new Set<string>();
  const results: ExperimentalPluginCommandPaletteSearchResult[] = [];
  for (const task of tasks) {
    if (results.length >= TASKS_PALETTE_RESULT_LIMIT) break;
    if (seen.has(task.id)) continue;
    seen.add(task.id);
    results.push(paletteResult(task));
  }
  return results;
}
