import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const TASKS_PLUGIN_ID = "tasks";

const boardSchema = z.object({
  id: z.string(),
  name: z.string(),
  prefix: z.string(),
  linkedBbProjectId: z.string().nullable(),
});

const taskSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  key: z.string(),
  title: z.string(),
  status: z.string(),
});

const boardsResult = z.object({ projects: z.array(boardSchema) });
const createResult = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), task: taskSchema }),
  z.object({
    ok: z.literal(false),
    error: z.object({ message: z.string() }),
  }),
]);
const taskResult = z.object({ task: taskSchema.nullable() });
const threadsResult = z.object({
  taskThreads: z.array(
    z.object({ threadId: z.string(), title: z.string(), liveStatus: z.string() }),
  ),
});
const pullRequestsResult = z.object({
  pullRequests: z.array(
    z.object({
      url: z.string(),
      number: z.number(),
      title: z.string(),
      state: z.string(),
    }),
  ),
  unavailableThreadIds: z.array(z.string()),
});

export type TasksBoard = z.infer<typeof boardSchema>;
export type TasksTask = z.infer<typeof taskSchema>;
export type TasksCreateResult = z.infer<typeof createResult>;
export type TasksThreads = z.infer<typeof threadsResult>["taskThreads"];
export type TasksPullRequests = z.infer<typeof pullRequestsResult>;

export interface TasksClient {
  listBoards(): Promise<TasksBoard[]>;
  createTask(input: {
    projectId: string;
    title: string;
    description: string;
  }): Promise<TasksCreateResult>;
  getTask(taskId: string): Promise<TasksTask | null>;
  getTaskByKey(taskKey: string): Promise<TasksTask | null>;
  listThreads(taskId: string): Promise<TasksThreads>;
  listPullRequests(taskId: string): Promise<TasksPullRequests>;
}

export function tasksClient(bb: BbPluginApi): TasksClient {
  function call<Output>(
    method: string,
    outputSchema: z.ZodType<Output>,
    input: Record<string, string>,
  ): Promise<Output> {
    return bb.sdk.plugins.callRpc({
      pluginId: TASKS_PLUGIN_ID,
      method,
      input,
      outputSchema,
    });
  }
  return {
    async listBoards() {
      return (await call("listProjects", boardsResult, {})).projects;
    },
    createTask(input) {
      return call("createTask", createResult, input);
    },
    async getTask(taskId) {
      return (await call("getTask", taskResult, { taskId })).task;
    },
    async getTaskByKey(taskKey) {
      return (await call("getTaskByKey", taskResult, { taskKey })).task;
    },
    async listThreads(taskId) {
      return (await call("listTaskThreads", threadsResult, { taskId }))
        .taskThreads;
    },
    listPullRequests(taskId) {
      return call("listTaskPullRequests", pullRequestsResult, { taskId });
    },
  };
}
