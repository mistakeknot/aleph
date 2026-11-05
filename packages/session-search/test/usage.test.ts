import { describe, expect, it } from "vitest";

import {
  cumulativeToDeltas,
  dedupeByKey,
  parseJsonl,
  type UsageRecord,
} from "../src/index.js";

function snapshot(
  total: number | null,
  input: number | null = total,
): UsageRecord {
  return {
    kind: "usage",
    provider: "codex",
    sessionId: "s",
    agentId: null,
    sidechain: false,
    parentCallId: null,
    cwd: null,
    eventTimeMs: null,
    dedupeKey: `k${total}`,
    basis: "cumulative",
    origin: "codex-token-count",
    scopeKey: "codex:s",
    model: null,
    inputTokens: input,
    outputTokens: 0,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    reasoningTokens: null,
    totalTokens: total,
    inputIncludesCache: true,
    costUsd: null,
  };
}

describe("cumulativeToDeltas", () => {
  it("has no delta for the first snapshot without a baseline", () => {
    const [first] = cumulativeToDeltas([snapshot(10)]);
    expect(first?.delta).toBeNull();
    expect(first?.reset).toBe(false);
  });

  it("subtracts successive snapshots and yields zero for repeated snapshots", () => {
    const result = cumulativeToDeltas([
      snapshot(10),
      snapshot(10),
      snapshot(25),
    ]);
    expect(result.map((entry) => entry.delta?.totalTokens ?? null)).toEqual([
      null,
      0,
      15,
    ]);
  });

  it("flags a decrease as a reset with unknown delta and rebases", () => {
    const result = cumulativeToDeltas([
      snapshot(100),
      snapshot(30),
      snapshot(50),
    ]);
    expect(result[1]).toMatchObject({ reset: true, delta: null });
    expect(result[2]?.delta?.totalTokens).toBe(20);
    expect(result[2]?.reset).toBe(false);
  });

  it("keeps a field unknown when either side is unknown", () => {
    const result = cumulativeToDeltas([snapshot(10, null), snapshot(20, 7)]);
    expect(result[1]?.delta).toMatchObject({
      totalTokens: 10,
      inputTokens: null,
    });
  });

  it("uses a provided baseline for the first snapshot", () => {
    const result = cumulativeToDeltas([snapshot(25)], snapshot(10));
    expect(result[0]?.delta?.totalTokens).toBe(15);
  });

  it("refuses to mix scopes or delta-basis records", () => {
    const other = { ...snapshot(5), scopeKey: "codex:other" };
    expect(() => cumulativeToDeltas([snapshot(1), other])).toThrow(/scope/);
    const delta = { ...snapshot(5), basis: "delta" as const };
    expect(() => cumulativeToDeltas([delta])).toThrow(/cumulative/);
  });
});

describe("dedupeByKey and parseJsonl", () => {
  it("keeps the first record for each dedupe key in order", () => {
    const a = snapshot(1);
    const b = { ...snapshot(2), dedupeKey: a.dedupeKey };
    const c = snapshot(3);
    expect(dedupeByKey([a, b, c])).toEqual([a, c]);
  });

  it("skips blank and malformed lines and counts the malformed ones", () => {
    const parsed = parseJsonl('{"a":1}\n\n{broken\r\n[1]\n"x"\n{"b":2}');
    expect(parsed.records).toEqual([{ a: 1 }, [1], "x", { b: 2 }]);
    expect(parsed.malformedLines).toBe(1);
  });
});
