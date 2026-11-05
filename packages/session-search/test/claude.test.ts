import { describe, expect, it } from "vitest";

import { dedupeByKey, normalize, parseJsonl } from "../src/index.js";
import {
  claudeSessionId,
  normalizeFixture,
  ofKind,
  readFixtureText,
} from "./helpers.js";

const claude = { provider: "claude" } as const;

describe("claude normalization", () => {
  it("parses fixture lines and counts the truncated trailing line", () => {
    const parsed = parseJsonl(readFixtureText("claude/session-main.jsonl"));
    expect(parsed.records).toHaveLength(13);
    expect(parsed.malformedLines).toBe(1);
  });

  it("ignores unknown, bookkeeping and non-object records", () => {
    const records = [
      { type: "queue-operation", operation: "enqueue" },
      {
        type: "system",
        subtype: "compact_boundary",
        compactMetadata: { preTokens: 1 },
      },
      { type: "future-record-type", payload: { anything: "here" } },
      { type: "attachment", attachment: { type: "x" } },
      { type: "api-request", body: "x" },
      { type: "assistant" },
      { type: "assistant", message: "not an object" },
      { type: "user", message: { role: "user", content: 7 } },
      {},
      null,
      "text",
      7,
      [],
    ];
    for (const record of records) {
      expect(normalize(record, claude)).toEqual([]);
    }
  });

  it("emits user text, assistant text and skips thinking content", () => {
    const records = normalizeFixture("claude/session-main.jsonl", claude);
    const messages = ofKind(records, "message");
    expect(messages.map((message) => [message.role, message.text])).toEqual([
      ["user", "Fix the parser bug in src/a.ts"],
      ["assistant", "Reading the file first."],
    ]);
    expect(messages[0]).toMatchObject({
      provider: "claude",
      sessionId: claudeSessionId,
      sidechain: false,
      agentId: null,
      cwd: "/work/project",
      eventTimeMs: Date.parse("2026-01-02T03:04:05.000Z"),
    });
    expect(JSON.stringify(records)).not.toContain("private chain of thought");
  });

  it("derives structured and inferred file touches from tool calls", () => {
    const calls = ofKind(
      normalizeFixture("claude/session-main.jsonl", claude),
      "tool_call",
    );
    const byCall = new Map(calls.map((call) => [call.callId, call]));
    expect(byCall.get("toolu_1")?.touches).toEqual([
      {
        path: "/work/project/src/a.ts",
        access: "read",
        confidence: "structured",
      },
    ]);
    expect(byCall.get("toolu_2")?.touches).toEqual([
      {
        path: "/work/project/src/a.ts",
        access: "write",
        confidence: "structured",
      },
    ]);
    expect(byCall.get("toolu_3")?.touches).toEqual([
      { path: "src/a.ts", access: "reference", confidence: "inferred" },
      { path: "src/b.ts", access: "reference", confidence: "inferred" },
    ]);
    expect(byCall.get("toolu_3")?.argumentsText).toContain("grep -n foo");
    expect(byCall.get("toolu_4")).toMatchObject({
      name: "Task",
      delegation: true,
      touches: [],
    });
    expect(byCall.get("toolu_1")?.delegation).toBe(false);
  });

  it("emits tool results from string and block content", () => {
    const results = ofKind(
      normalizeFixture("claude/session-main.jsonl", claude),
      "tool_result",
    );
    expect(results.map((result) => [result.callId, result.text])).toEqual([
      ["toolu_1", "export const a = 1;"],
      ["toolu_2", "Edited."],
      ["toolu_3", "export const a = 2;"],
      ["toolu_4", "Subagent summary: one export."],
    ]);
  });

  it("repeats split-line usage with one dedupe key per API message", () => {
    const usage = ofKind(
      normalizeFixture("claude/session-main.jsonl", claude),
      "usage",
    ).filter((record) => record.origin === "claude-message");
    expect(usage).toHaveLength(5);
    expect(new Set(usage.map((record) => record.dedupeKey)).size).toBe(3);
    const unique = dedupeByKey(usage);
    expect(unique).toHaveLength(3);
    expect(
      unique.reduce((sum, record) => sum + (record.inputTokens ?? 0), 0),
    ).toBe(45);
    expect(unique[0]).toMatchObject({
      basis: "delta",
      model: "claude-test-model",
      inputTokens: 10,
      outputTokens: 4,
      cacheReadTokens: 100,
      cacheWriteTokens: 20,
      reasoningTokens: null,
      totalTokens: null,
      inputIncludesCache: false,
      costUsd: null,
      scopeKey: `claude:${claudeSessionId}:main`,
    });
  });

  it("keeps unknown usage fields null rather than zero", () => {
    const unique = dedupeByKey(
      ofKind(
        normalizeFixture("claude/session-main.jsonl", claude),
        "usage",
      ).filter((record) => record.origin === "claude-message"),
    );
    expect(unique[2]).toMatchObject({
      inputTokens: 5,
      outputTokens: 2,
      cacheReadTokens: null,
      cacheWriteTokens: null,
    });
  });

  it("treats cost-state as a separate cumulative snapshot, not a delta", () => {
    const snapshots = ofKind(
      normalizeFixture("claude/session-main.jsonl", claude),
      "usage",
    ).filter((record) => record.origin === "claude-cost-state");
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({
      basis: "cumulative",
      scopeKey: `claude:${claudeSessionId}`,
      model: "claude-test-model",
      inputTokens: 60,
      outputTokens: 20,
      cacheReadTokens: 300,
      cacheWriteTokens: 20,
      costUsd: 0.5,
      inputIncludesCache: false,
    });
  });

  it("marks nested subagent records as sidechain with their own usage scope", () => {
    const records = normalizeFixture("claude/subagent-agent-a1.jsonl", claude);
    expect(records.length).toBeGreaterThan(0);
    for (const record of records) {
      expect(record).toMatchObject({
        sidechain: true,
        agentId: "a1",
        sessionId: claudeSessionId,
      });
    }
    const usage = ofKind(records, "usage");
    expect(usage.map((record) => record.scopeKey)).toEqual([
      `claude:${claudeSessionId}:a1`,
      `claude:${claudeSessionId}:a1`,
    ]);
  });

  it("does not collide parent and nested keys, and keeps both subagent representations", () => {
    const main = normalizeFixture("claude/session-main.jsonl", claude);
    const nested = normalizeFixture("claude/subagent-agent-a1.jsonl", claude);
    const merged = dedupeByKey([...main, ...nested]);
    expect(merged).toHaveLength(main.length - 2 + nested.length);
    const summary = "Subagent summary: one export.";
    const withSummary = merged.filter(
      (record) =>
        (record.kind === "message" || record.kind === "tool_result") &&
        record.text === summary,
    );
    expect(withSummary.map((record) => record.sidechain).sort()).toEqual([
      false,
      true,
    ]);
    const task = ofKind(merged, "tool_call").find(
      (call) => call.name === "Task",
    );
    const parentResult = ofKind(merged, "tool_result").find(
      (result) => result.text === summary,
    );
    expect(parentResult?.callId).toBe(task?.callId);
  });

  it("takes the agent id from the source when the record omits it", () => {
    const record = {
      isSidechain: true,
      type: "assistant",
      message: {
        id: "m1",
        role: "assistant",
        content: [{ type: "text", text: "hi" }],
      },
      uuid: "x1",
      sessionId: claudeSessionId,
    };
    const [message] = normalize(record, { provider: "claude", agentId: "a9" });
    expect(message).toMatchObject({
      kind: "message",
      agentId: "a9",
      sidechain: true,
    });
  });

  it("uses the source session when the record has none and null time for bad timestamps", () => {
    const record = {
      type: "user",
      message: { role: "user", content: "hello" },
      uuid: "u9",
      timestamp: "not a date",
    };
    const [message] = normalize(record, {
      provider: "claude",
      sessionId: "from-source",
    });
    expect(message).toMatchObject({
      sessionId: "from-source",
      eventTimeMs: null,
    });
  });
});
