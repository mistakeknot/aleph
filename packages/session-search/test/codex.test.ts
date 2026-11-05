import { describe, expect, it } from "vitest";

import { cumulativeToDeltas, dedupeByKey, normalize } from "../src/index.js";
import { codexSessionId, normalizeFixture, ofKind } from "./helpers.js";

const codex = { provider: "codex", sessionId: codexSessionId } as const;

describe("codex normalization", () => {
  it("ignores event_msg projections, developer text, reasoning, world state and unknown types", () => {
    const records = normalizeFixture("codex/rollout.jsonl", codex);
    const text = JSON.stringify(records);
    expect(text).not.toContain("developer instructions");
    expect(text).not.toContain("opaque");
    expect(text).not.toContain("system prompt text");
    expect(normalize({ type: "future", payload: {} }, codex)).toEqual([]);
    expect(
      normalize({ type: "response_item", payload: { type: "future" } }, codex),
    ).toEqual([]);
    expect(
      normalize(
        { type: "event_msg", payload: { type: "item_completed" } },
        codex,
      ),
    ).toEqual([]);
    expect(normalize(null, codex)).toEqual([]);
    expect(normalize({ type: "response_item" }, codex)).toEqual([]);
  });

  it("uses response_item as the single canonical message representation", () => {
    const messages = ofKind(
      normalizeFixture("codex/rollout.jsonl", codex),
      "message",
    );
    expect(messages.map((message) => [message.role, message.text])).toEqual([
      ["user", "Update src/a.ts and show the diff"],
      ["assistant", "Updated src/a.ts."],
    ]);
    expect(messages[0]).toMatchObject({
      provider: "codex",
      sessionId: codexSessionId,
      sidechain: false,
      eventTimeMs: Date.parse("2026-01-02T04:00:02.000Z"),
    });
  });

  it("emits session and turn context records with cwd and model", () => {
    const sessions = ofKind(
      normalizeFixture("codex/rollout.jsonl", codex),
      "session",
    );
    expect(sessions.map((session) => [session.cwd, session.model])).toEqual([
      ["/work/project", null],
      ["/work/project", "codex-test-model"],
    ]);
    expect(sessions[0]?.sessionId).toBe(codexSessionId);
  });

  it("derives touches: patch headers are structured writes, shell is inferred", () => {
    const calls = ofKind(
      normalizeFixture("codex/rollout.jsonl", codex),
      "tool_call",
    );
    const byCall = new Map(calls.map((call) => [call.callId, call]));
    expect(byCall.get("call_1")).toMatchObject({
      name: "shell",
      delegation: false,
      touches: [
        { path: "src/a.ts", access: "reference", confidence: "inferred" },
      ],
    });
    expect(byCall.get("call_2")?.touches).toEqual([
      { path: "src/a.ts", access: "write", confidence: "structured" },
      { path: "src/c.ts", access: "write", confidence: "structured" },
    ]);
    const results = ofKind(
      normalizeFixture("codex/rollout.jsonl", codex),
      "tool_result",
    );
    expect(results.map((result) => [result.callId, result.text])).toEqual([
      ["call_1", "export const a = 1;"],
      ["call_2", "Success. Updated the following files."],
    ]);
  });

  it("prefers token_usage_record deltas and keeps token_count as a cumulative snapshot", () => {
    const usage = ofKind(
      normalizeFixture("codex/rollout.jsonl", codex),
      "usage",
    );
    const deltas = usage.filter(
      (record) => record.origin === "codex-token-usage-record",
    );
    const snapshots = usage.filter(
      (record) => record.origin === "codex-token-count",
    );
    expect(deltas).toHaveLength(1);
    expect(deltas[0]).toMatchObject({
      basis: "delta",
      dedupeKey: "codex:usage:resp_1",
      scopeKey: `codex:${codexSessionId}`,
      inputTokens: 100,
      cacheReadTokens: 60,
      cacheWriteTokens: 0,
      outputTokens: 10,
      reasoningTokens: 4,
      totalTokens: 110,
      inputIncludesCache: true,
    });
    expect(snapshots).toHaveLength(2);
    expect(snapshots.every((record) => record.basis === "cumulative")).toBe(
      true,
    );
    expect(new Set(snapshots.map((record) => record.dedupeKey)).size).toBe(2);
    expect(snapshots[0]).toMatchObject({ totalTokens: 110, inputTokens: 100 });
  });

  it("emits no usage for a token_count without info", () => {
    const record = {
      timestamp: "2026-01-02T04:00:09.000Z",
      ordinal: 17,
      type: "event_msg",
      payload: { type: "token_count", info: null, rate_limits: null },
    };
    expect(normalize(record, codex)).toEqual([]);
  });

  it("keeps unknown token fields null", () => {
    const record = {
      type: "token_usage_record",
      ordinal: 3,
      payload: {
        response_id: "r9",
        usage: { input_tokens: 5, output_tokens: 1 },
      },
    };
    const [usage] = normalize(record, codex);
    expect(usage).toMatchObject({
      kind: "usage",
      inputTokens: 5,
      outputTokens: 1,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      reasoningTokens: null,
      totalTokens: null,
    });
  });

  it("keeps distinct records apart when no ordinal is present and the timestamp repeats", () => {
    const at = "2026-01-02T04:00:10.000Z";
    const user = {
      timestamp: at,
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "first" }],
      },
    };
    const assistant = {
      timestamp: at,
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "second" }],
      },
    };
    const records = [user, assistant, user].flatMap((record) =>
      normalize(record, codex),
    );
    expect(records).toHaveLength(3);
    expect(dedupeByKey(records)).toHaveLength(2);
  });

  it("uses the source position to keep timestamp-sharing cumulative counts apart", () => {
    const at = "2026-01-02T04:00:11.000Z";
    const count = (total: number) => ({
      timestamp: at,
      type: "event_msg",
      payload: {
        type: "token_count",
        info: { total_token_usage: { input_tokens: total, output_tokens: 1 } },
      },
    });
    const records = [100, 30, 100, 30, 50].flatMap((total, position) =>
      normalize(count(total), { ...codex, position }),
    );
    const usage = ofKind(dedupeByKey(records), "usage");
    expect(usage).toHaveLength(5);
    expect(cumulativeToDeltas(usage).map((entry) => entry.reset)).toEqual([
      false,
      true,
      false,
      true,
      false,
    ]);
  });

  it("produces unique dedupe keys across the whole rollout", () => {
    const records = normalizeFixture("codex/rollout.jsonl", codex);
    expect(dedupeByKey(records)).toHaveLength(records.length);
  });
});
