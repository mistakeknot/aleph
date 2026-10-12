import { describe, expect, it } from "vitest";
import type { PluginRpcClient } from "@get-bb/plugin-sdk";
import { makeTask, rpcInput } from "../test-fixtures.js";
import {
  searchTasksForPalette,
  TASKS_PALETTE_RESULT_LIMIT,
} from "./palette-search.js";

const exact = makeTask({
  id: "01HZZZZZZZZZZZZZZZZZZZZZT7",
  number: 316,
  key: "AUTA-316",
  title: "Search cards from the palette",
  status: "in_progress",
});

function stubRpc(responses: Record<string, unknown>) {
  const calls: { method: string; input: Record<string, unknown> }[] = [];
  const rpc = {
    call: async (method: string, input?: unknown) => {
      calls.push({ method, input: rpcInput(input) });
      return responses[method];
    },
  } as PluginRpcClient;
  return { rpc, calls };
}

function context(rpc: PluginRpcClient) {
  return { rpc, projectId: null, signal: new AbortController().signal };
}

describe("searchTasksForPalette", () => {
  it("puts the exact key first, dedupes it, and opens the task route", async () => {
    const other = makeTask({ key: "AUTA-3160", title: "Other" });
    const { rpc, calls } = stubRpc({
      getTaskByKey: { task: exact },
      listTasks: { tasks: [other, exact], nextCursor: null },
    });

    const results = await searchTasksForPalette(" auta-316 ", context(rpc));

    expect(results).toEqual([
      {
        id: exact.id,
        title: "AUTA-316 Search cards from the palette",
        detail: "In Progress",
        open: { panelPath: "tasks", subPath: "task/AUTA-316" },
      },
      {
        id: other.id,
        title: "AUTA-3160 Other",
        detail: "Todo",
        open: { panelPath: "tasks", subPath: "task/AUTA-3160" },
      },
    ]);
    expect(calls).toEqual([
      { method: "getTaskByKey", input: { taskKey: "AUTA-316" } },
      {
        method: "listTasks",
        input: {
          search: "auta-316",
          activeOnly: false,
          limit: TASKS_PALETTE_RESULT_LIMIT,
        },
      },
    ]);
  });

  it("searches titles without a key lookup and caps the results", async () => {
    const tasks = Array.from(
      { length: TASKS_PALETTE_RESULT_LIMIT },
      (_, index) =>
        makeTask({
          id: `01HZZZZZZZZZZZZZZZZZZZZZ${String(index).padStart(2, "0")}`,
          key: `TSK-${index + 1}`,
          title: `Sidebar ${index + 1}`,
        }),
    );
    const { rpc, calls } = stubRpc({
      listTasks: { tasks, nextCursor: "next" },
    });

    const results = await searchTasksForPalette("sidebar", context(rpc));

    expect(results).toHaveLength(TASKS_PALETTE_RESULT_LIMIT);
    expect(calls.map((call) => call.method)).toEqual(["listTasks"]);
  });

  it("skips queries shorter than two characters", async () => {
    const { rpc, calls } = stubRpc({});
    expect(await searchTasksForPalette(" a ", context(rpc))).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("rejects a response that does not match the contract", async () => {
    const { rpc } = stubRpc({ listTasks: { tasks: [{ id: 1 }] } });
    await expect(
      searchTasksForPalette("sidebar", context(rpc)),
    ).rejects.toThrow();
  });
});
