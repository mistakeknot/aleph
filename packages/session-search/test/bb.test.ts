import { describe, expect, it } from "vitest";

import { cumulativeToDeltas, dedupeByKey, normalize } from "../src/index.js";
import { fixturePath, ofKind } from "./helpers.js";
import { readFileSync } from "node:fs";

const rows: unknown[] = JSON.parse(
  readFileSync(fixturePath("bb/events.json"), "utf8"),
);
const bb = { provider: "bb" } as const;
const all = rows.flatMap((row) => normalize(row, bb));

describe("bb event normalization", () => {
  it("ignores deltas, started items, reasoning, gauges and unhandled events", () => {
    for (const index of [1, 2, 8, 9, 12, 13]) {
      expect(normalize(rows[index], bb)).toEqual([]);
    }
    expect(JSON.stringify(all)).not.toContain("hidden");
    expect(normalize({ type: "item/completed" }, bb)).toEqual([]);
    expect(normalize({ type: "future/event", data: "{}" }, bb)).toEqual([]);
    expect(
      normalize(
        { type: "item/completed", item_kind: "agentMessage", data: "{" },
        bb,
      ),
    ).toEqual([]);
    expect(normalize(null, bb)).toEqual([]);
  });

  it("emits the user input and the assistant message with event time", () => {
    const messages = ofKind(all, "message");
    expect(messages.map((message) => [message.role, message.text])).toEqual([
      ["user", "Update src/a.ts"],
      ["assistant", "Done."],
    ]);
    expect(messages[1]).toMatchObject({
      provider: "bb",
      sessionId: "thr_fixture",
      eventTimeMs: 1767326400070,
      dedupeKey: "bb:evt-0008:0",
    });
  });

  it("splits command executions into a call and a result with inferred touches", () => {
    const call = ofKind(all, "tool_call").find(
      (record) => record.callId === "cmd-1",
    );
    expect(call).toMatchObject({
      name: "commandExecution",
      argumentsText: "cat src/a.ts",
      cwd: "/work/project",
      touches: [
        { path: "src/a.ts", access: "reference", confidence: "inferred" },
      ],
    });
    const result = ofKind(all, "tool_result").find(
      (record) => record.callId === "cmd-1",
    );
    expect(result?.text).toBe("export const a = 1;");
  });

  it("derives structured touches from file reads and file changes", () => {
    const calls = ofKind(all, "tool_call");
    expect(calls.find((record) => record.callId === "fr-1")?.touches).toEqual([
      {
        path: "/work/project/src/b.ts",
        access: "read",
        confidence: "structured",
      },
    ]);
    expect(calls.find((record) => record.callId === "fc-1")?.touches).toEqual([
      {
        path: "/work/project/src/a.ts",
        access: "write",
        confidence: "structured",
      },
    ]);
  });

  it("normalizes generic tool calls and delegations", () => {
    const calls = ofKind(all, "tool_call");
    expect(calls.find((record) => record.callId === "tc-1")).toMatchObject({
      name: "bash",
      touches: [],
    });
    expect(
      ofKind(all, "tool_result").find((record) => record.callId === "tc-1")
        ?.text,
    ).toBe("a.ts\nb.ts");
    const delegation = calls.find((record) => record.callId === "dg-1");
    expect(delegation).toMatchObject({
      delegation: true,
      sidechain: true,
      parentCallId: "tc-9",
    });
    expect(
      ofKind(all, "tool_result").find((record) => record.callId === "dg-1")
        ?.text,
    ).toBe("Subagent summary: one export.");
  });

  it("emits tokenUsage totals as cumulative snapshots per provider thread", () => {
    const usage = ofKind(all, "usage");
    expect(usage).toHaveLength(2);
    expect(usage[0]).toMatchObject({
      basis: "cumulative",
      origin: "bb-token-usage",
      scopeKey: "bb:thr_fixture:prov-1",
      totalTokens: 110,
      inputTokens: 100,
      cacheReadTokens: 60,
      cacheWriteTokens: 0,
      outputTokens: 10,
      reasoningTokens: 4,
      inputIncludesCache: null,
    });
    expect(usage[1]).toMatchObject({ totalTokens: 250, cacheReadTokens: 150 });
  });

  it("derives deltas only from a known baseline", () => {
    const usage = ofKind(all, "usage");
    const withoutBaseline = cumulativeToDeltas(usage);
    expect(withoutBaseline[0]?.delta).toBeNull();
    expect(withoutBaseline[1]?.delta).toMatchObject({
      totalTokens: 140,
      inputTokens: 120,
      cacheReadTokens: 90,
      outputTokens: 20,
      reasoningTokens: 5,
    });
    const withBaseline = cumulativeToDeltas(usage, usage[0]);
    expect(withBaseline[0]?.delta).toMatchObject({ totalTokens: 0 });
  });

  it("records the destination of a renamed file as a structured write touch", () => {
    const event = {
      type: "item/completed",
      item_kind: "fileChange",
      thread_id: "t1",
      id: "ev-rename",
      data: JSON.stringify({
        item: {
          type: "fileChange",
          id: "fc-rename",
          changes: [
            {
              path: "src/old.ts",
              kind: "update",
              movePath: "src/new.ts",
              diff: "",
            },
            { path: "src/same.ts", kind: "update", movePath: "src/same.ts" },
            { path: "src/plain.ts", kind: "update", movePath: null },
          ],
        },
      }),
    };
    const [call] = normalize(event, bb);
    expect(call).toMatchObject({
      kind: "tool_call",
      name: "fileChange",
      touches: [
        { path: "src/old.ts", access: "write", confidence: "structured" },
        { path: "src/new.ts", access: "write", confidence: "structured" },
        { path: "src/same.ts", access: "write", confidence: "structured" },
        { path: "src/plain.ts", access: "write", confidence: "structured" },
      ],
    });
    expect(call).toMatchObject({
      argumentsText: expect.stringContaining("src/old.ts -> src/new.ts"),
    });
  });

  it("keeps id-less, sequence-less events apart by source position", () => {
    const event = (total: number) => ({
      type: "thread/tokenUsage/updated",
      thread_id: "t1",
      created_at: "2026-01-02T03:04:05.000Z",
      data: JSON.stringify({
        tokenUsage: { total: { totalTokens: total, inputTokens: total } },
      }),
    });
    const records = [100, 30, 100, 30, 50].flatMap((total, position) =>
      normalize(event(total), { provider: "bb", position }),
    );
    expect(ofKind(dedupeByKey(records), "usage")).toHaveLength(5);
  });
});
