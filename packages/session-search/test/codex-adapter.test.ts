import {
  appendFileSync,
  closeSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  renameSync,
  rmSync,
  truncateSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { readPage as readClaudePage } from "../src/adapters/claude.js";
import {
  CODEX_CURSOR_PREFIX,
  codexCursorOffset,
  decodeCodexCursor,
  readCodexPage,
  sessionIdFromRolloutPath,
  type CodexSource,
} from "../src/adapters/codex.js";
import type {
  PageBudget,
  ReadPageDeps,
  SourcePage,
} from "../src/adapters/jsonl-page.js";
import { oversizedDedupeKey } from "../src/admission.js";
import {
  cumulativeToDeltas,
  dedupeByKey,
  type NormalizedRecord,
  type UsageRecord,
} from "../src/index.js";
import {
  openReadonlyConnection,
  type CommitResult,
  type SessionSearchStore,
  type SourceRef,
} from "../src/storage.js";
import { newReaderStats } from "../src/streaming-reader.js";
import { codexSessionId, fixturePath, ofKind } from "./helpers.js";
import {
  cleanupStoreDirs,
  makeStoreDir,
  openTestStore,
  source,
} from "./support/store-helpers.js";

const MIB = 1024 * 1024;
const SESSION = "33333333-3333-4333-8333-333333333333";
const open: SessionSearchStore[] = [];
const dirs: string[] = [];

afterEach(() => {
  while (open.length > 0) open.pop()!.close();
  while (dirs.length > 0) {
    rmSync(dirs.pop()!, { recursive: true, force: true });
  }
  cleanupStoreDirs();
});

function track(dir: string): SessionSearchStore {
  const store = openTestStore(dir);
  open.push(store);
  return store;
}

function workdir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ss-codex-"));
  dirs.push(dir);
  return dir;
}

let ordinal = 0;

function rec(type: string, payload: unknown, at = ordinal + 1): string {
  ordinal = at;
  return JSON.stringify({
    timestamp: "2026-01-02T04:00:00.000Z",
    ordinal: at,
    type,
    payload,
  });
}

function meta(id: string = SESSION): string {
  return rec("session_meta", { session_id: id, id, cwd: "/work/project" });
}

function context(model: string | null): string {
  return rec("turn_context", {
    turn_id: "turn-1",
    cwd: "/work/project",
    model,
  });
}

function message(role: "user" | "assistant", text: string): string {
  return rec("response_item", {
    type: "message",
    role,
    content: [{ type: role === "user" ? "input_text" : "output_text", text }],
  });
}

function itemCompleted(text: string): string {
  return rec("event_msg", {
    type: "item_completed",
    item: {
      type: "AgentMessage",
      id: "i-1",
      content: [{ type: "Text", text }],
    },
  });
}

function toolCall(callId: string, command: string): string {
  return rec("response_item", {
    type: "function_call",
    name: "shell",
    arguments: JSON.stringify({ command: ["bash", "-lc", command] }),
    call_id: callId,
  });
}

function toolOutput(callId: string, output: string): string {
  return rec("response_item", {
    type: "function_call_output",
    call_id: callId,
    output,
  });
}

type Counters = Record<string, number | undefined>;

function totals(input: Counters | null): unknown {
  return input === null
    ? null
    : {
        total_token_usage: input,
        last_token_usage: input,
        model_context_window: 1000,
      };
}

function tokenCount(input: Counters | null): string {
  return rec("event_msg", {
    type: "token_count",
    info: totals(input),
    rate_limits: null,
  });
}

function usageRecord(responseId: string | null, usage: Counters): string {
  return rec("token_usage_record", {
    session_id: SESSION,
    turn_id: "turn-1",
    response_id: responseId,
    usage,
  });
}

function counters(input: number, output: number): Counters {
  return {
    input_tokens: input,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: output,
    reasoning_output_tokens: 0,
    total_tokens: input + output,
  };
}

function file(lines: string[]): string {
  return lines.join("\n") + "\n";
}

function count(dir: string, table: string): number {
  const db = openReadonlyConnection(dir);
  try {
    return (
      db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }
    ).n;
  } finally {
    db.close();
  }
}

function quarantineRows(dir: string): Array<Record<string, unknown>> {
  const db = openReadonlyConnection(dir);
  try {
    return db
      .prepare(
        "SELECT dedupe_key, reason, start_offset, end_offset, byte_length FROM quarantine ORDER BY id",
      )
      .all() as Array<Record<string, unknown>>;
  } finally {
    db.close();
  }
}

function codexSource(ref: SourceRef, path: string): CodexSource {
  return { ref, path };
}

function committed(page: SourcePage, store: SessionSearchStore): CommitResult {
  if (page.status !== "page")
    throw new Error(`expected page, got ${page.status}`);
  const result = store.commitBatch(page.batch, page.cursor);
  if (!result.committed) {
    throw new Error(`commit refused: ${result.refusal?.message}`);
  }
  return result;
}

async function drain(
  store: SessionSearchStore,
  src: CodexSource,
  budget?: PageBudget,
  deps?: ReadPageDeps,
): Promise<SourcePage[]> {
  const pages: SourcePage[] = [];
  for (let guard = 0; guard < 10_000; guard += 1) {
    const page = await readCodexPage(
      src,
      store.getCursor(src.ref),
      budget,
      deps,
    );
    pages.push(page);
    if (page.status !== "page") return pages;
    committed(page, store);
  }
  throw new Error("drain did not terminate");
}

function recordsOf(pages: SourcePage[]): NormalizedRecord[] {
  return pages.flatMap((page) =>
    page.status === "page" ? (page.batch.records as NormalizedRecord[]) : [],
  );
}

function cursorOffsetOf(store: SessionSearchStore, ref: SourceRef): number {
  const cursor = store.getCursor(ref);
  if (cursor === null) throw new Error("no cursor");
  return decodeCodexCursor(cursor)!.offset;
}

function usageOf(records: NormalizedRecord[]): UsageRecord[] {
  return ofKind(records, "usage");
}

async function readAll(
  path: string,
  sessionId?: string,
): Promise<NormalizedRecord[]> {
  const dir = makeStoreDir();
  const store = track(dir);
  const ref = source("codex-all", 1);
  const src: CodexSource =
    sessionId === undefined ? { ref, path } : { ref, path, sessionId };
  return recordsOf(await drain(store, src));
}

describe("readCodexPage with the real store", () => {
  it("indexes the sanitized rollout fixture once, with tool calls, results and touches", async () => {
    const dir = makeStoreDir();
    const store = track(dir);
    const ref = source("codex-fixture", 1);
    const src = codexSource(ref, fixturePath("codex/rollout.jsonl"));

    const pages = await drain(store, src);
    expect(pages.map((page) => page.status)).toEqual(["page", "idle"]);
    const records = recordsOf(pages);

    const messages = ofKind(records, "message");
    expect(messages.map((entry) => [entry.role, entry.text])).toEqual([
      ["user", "Update src/a.ts and show the diff"],
      ["assistant", "Updated src/a.ts."],
    ]);
    const calls = ofKind(records, "tool_call");
    expect(calls.map((entry) => [entry.callId, entry.name])).toEqual([
      ["call_1", "shell"],
      ["call_2", "apply_patch"],
    ]);
    expect(calls[1]!.touches).toEqual([
      { path: "src/a.ts", access: "write", confidence: "structured" },
      { path: "src/c.ts", access: "write", confidence: "structured" },
    ]);
    const results = ofKind(records, "tool_result");
    expect(results.map((entry) => [entry.callId, entry.text])).toEqual([
      ["call_1", "export const a = 1;"],
      ["call_2", "Success. Updated the following files."],
    ]);
    expect(count(dir, "content")).toBe(6);
    expect(count(dir, "touch")).toBeGreaterThan(0);
    for (const entry of records) {
      expect(entry.provider).toBe("codex");
      expect(entry.sessionId).toBe(codexSessionId);
    }
    expect(cursorOffsetOf(store, ref)).toBeGreaterThan(0);
  });

  it("stores an assistant message once although two representations are present", async () => {
    const dir = makeStoreDir();
    const store = track(dir);
    const path = join(workdir(), "dup.jsonl");
    ordinal = 0;
    writeFileSync(
      path,
      file([
        meta(),
        message("assistant", "Done."),
        itemCompleted("Done."),
        itemCompleted("Done."),
      ]),
    );
    const ref = source("codex-dup", 1);
    const records = recordsOf(await drain(store, codexSource(ref, path)));
    expect(ofKind(records, "message")).toHaveLength(1);
    expect(count(dir, "content")).toBe(1);
  });

  it("stores a line repeated with the same ordinal once", async () => {
    const dir = makeStoreDir();
    const store = track(dir);
    const path = join(workdir(), "repeat.jsonl");
    ordinal = 0;
    const repeated = message("assistant", "Same line twice.");
    writeFileSync(path, file([meta(), repeated, repeated]));
    const ref = source("codex-repeat", 1);
    const records = recordsOf(await drain(store, codexSource(ref, path)));
    expect(ofKind(records, "message")).toHaveLength(2);
    expect(dedupeByKey(ofKind(records, "message"))).toHaveLength(1);
    expect(count(dir, "content")).toBe(1);
  });

  it("pairs tool calls with their results by call id across pages", async () => {
    const dir = makeStoreDir();
    const store = track(dir);
    const path = join(workdir(), "tools.jsonl");
    ordinal = 0;
    writeFileSync(
      path,
      file([
        meta(),
        toolCall("call_a", "ls src"),
        toolCall("call_b", "cat src/a.ts"),
        toolOutput("call_b", "export const a = 1;"),
        toolOutput("call_a", "a.ts"),
        toolOutput("call_orphan", "no matching call"),
      ]),
    );
    const pages = await drain(
      store,
      codexSource(source("codex-tools", 1), path),
      {
        maxRecords: 2,
        maxBytes: 2 * MIB,
        reserveBytes: 64 * 1024,
      } as PageBudget,
    );
    const records = recordsOf(pages);
    expect(
      ofKind(records, "tool_call").map((entry) => [entry.callId, entry.name]),
    ).toEqual([
      ["call_a", "shell"],
      ["call_b", "shell"],
    ]);
    expect(
      ofKind(records, "tool_result").map((entry) => [entry.callId, entry.text]),
    ).toEqual([
      ["call_b", "export const a = 1;"],
      ["call_a", "a.ts"],
      ["call_orphan", "no matching call"],
    ]);
    expect(count(dir, "content")).toBe(5);
  });

  it("does not re-store a replayed generation of the same file", async () => {
    const dir = makeStoreDir();
    const store = track(dir);
    const src = codexSource(
      source("codex-gen", 1),
      fixturePath("codex/rollout.jsonl"),
    );
    await drain(store, src);
    const before = count(dir, "content");
    await drain(store, codexSource(source("codex-gen", 2), src.path));
    expect(count(dir, "content")).toBe(before);
  });

  it("splitting a rollout into small pages yields the same records as one page", async () => {
    const path = fixturePath("codex/rollout.jsonl");
    const single = recordsOf(
      await drain(
        track(makeStoreDir()),
        codexSource(source("codex-one", 1), path),
      ),
    );
    const dir = makeStoreDir();
    const store = track(dir);
    const pages = await drain(
      store,
      codexSource(source("codex-many", 1), path),
      {
        maxRecords: 2,
        maxBytes: 2 * MIB,
        reserveBytes: 64 * 1024,
      } as PageBudget,
    );
    expect(
      pages.filter((page) => page.status === "page").length,
    ).toBeGreaterThan(1);
    expect(recordsOf(pages)).toEqual(single);
  });
});

describe("session identity", () => {
  it("prefers the supplied session id over the file content", async () => {
    const path = join(workdir(), `rollout-x-${SESSION}.jsonl`);
    ordinal = 0;
    writeFileSync(path, file([meta(), tokenCount(counters(10, 1))]));
    const records = await readAll(path, "caller-session");
    expect(usageOf(records)[0]!.scopeKey).toBe("codex:caller-session");
    expect(usageOf(records)[0]!.sessionId).toBe("caller-session");
  });

  it("reads the session id from session_meta so token_count lines get the right scope", async () => {
    const path = join(workdir(), "rollout-without-uuid.jsonl");
    ordinal = 0;
    writeFileSync(
      path,
      file([meta(), message("user", "hi"), tokenCount(counters(10, 1))]),
    );
    const records = await readAll(path);
    const usage = usageOf(records);
    expect(usage).toHaveLength(1);
    expect(usage[0]!.scopeKey).toBe(`codex:${SESSION}`);
    expect(ofKind(records, "message")[0]!.sessionId).toBe(SESSION);
  });

  it("keeps the scope stable on a page that does not contain session_meta", async () => {
    const dir = makeStoreDir();
    const store = track(dir);
    const path = join(workdir(), "later.jsonl");
    ordinal = 0;
    writeFileSync(
      path,
      file([
        meta(),
        message("user", "a"),
        message("user", "b"),
        tokenCount(counters(10, 1)),
      ]),
    );
    const ref = source("codex-later", 1);
    const pages = await drain(store, codexSource(ref, path), {
      maxRecords: 2,
      maxBytes: 2 * MIB,
      reserveBytes: 64 * 1024,
    } as PageBudget);
    const usage = usageOf(recordsOf(pages));
    expect(usage).toHaveLength(1);
    expect(usage[0]!.scopeKey).toBe(`codex:${SESSION}`);
  });

  it("falls back to the rollout filename when the file has no session_meta", async () => {
    const path = join(
      workdir(),
      `rollout-2026-01-02T04-00-00-${SESSION}.jsonl`,
    );
    ordinal = 0;
    writeFileSync(path, file([tokenCount(counters(10, 1))]));
    const records = await readAll(path);
    expect(usageOf(records)[0]!.scopeKey).toBe(`codex:${SESSION}`);
    expect(sessionIdFromRolloutPath(path)).toBe(SESSION);
    expect(sessionIdFromRolloutPath("/work/project/notes.jsonl")).toBeNull();
  });

  it("uses the unknown scope only when nothing identifies the session", async () => {
    const path = join(workdir(), "anonymous.jsonl");
    ordinal = 0;
    writeFileSync(path, file([tokenCount(counters(10, 1))]));
    const records = await readAll(path);
    expect(usageOf(records)[0]!.scopeKey).toBe("codex:unknown");
  });
});

describe("token usage", () => {
  it("derives deltas from cumulative counters across page boundaries and flags a reset", async () => {
    const dir = makeStoreDir();
    const store = track(dir);
    const path = join(workdir(), "usage.jsonl");
    ordinal = 0;
    writeFileSync(
      path,
      file([
        meta(),
        tokenCount(counters(100, 10)),
        message("user", "next"),
        tokenCount(counters(160, 25)),
        tokenCount(counters(160, 25)),
        message("user", "after"),
        tokenCount(counters(30, 5)),
        tokenCount(counters(50, 9)),
      ]),
    );
    const ref = source("codex-usage", 1);
    const pages = await drain(store, codexSource(ref, path), {
      maxRecords: 2,
      maxBytes: 2 * MIB,
      reserveBytes: 64 * 1024,
    } as PageBudget);
    expect(
      pages.filter((page) => page.status === "page").length,
    ).toBeGreaterThan(2);
    const usage = usageOf(recordsOf(pages));
    expect(usage).toHaveLength(5);
    expect(new Set(usage.map((entry) => entry.scopeKey))).toEqual(
      new Set([`codex:${SESSION}`]),
    );
    expect(new Set(usage.map((entry) => entry.dedupeKey)).size).toBe(5);
    expect(usage.every((entry) => entry.basis === "cumulative")).toBe(true);

    const deltas = cumulativeToDeltas(usage);
    expect(deltas.map((entry) => entry.reset)).toEqual([
      false,
      false,
      false,
      true,
      false,
    ]);
    expect(deltas[0]!.delta).toBeNull();
    expect(deltas[1]!.delta).toMatchObject({
      inputTokens: 60,
      outputTokens: 15,
      totalTokens: 75,
    });
    expect(deltas[2]!.delta).toMatchObject({ inputTokens: 0, outputTokens: 0 });
    expect(deltas[3]!.delta).toBeNull();
    expect(deltas[4]!.delta).toMatchObject({
      inputTokens: 20,
      outputTokens: 4,
      totalTokens: 24,
    });
  });

  it("keeps unknown counters null instead of zero and ignores missing usage", async () => {
    const path = join(workdir(), "missing.jsonl");
    ordinal = 0;
    writeFileSync(
      path,
      file([
        meta(),
        tokenCount(null),
        tokenCount({ input_tokens: 40, total_tokens: 50 }),
        tokenCount({ input_tokens: 70, total_tokens: 90 }),
        rec("event_msg", { type: "token_count", rate_limits: null }),
        rec("event_msg", {
          type: "token_count",
          info: { model_context_window: 5 },
        }),
      ]),
    );
    const usage = usageOf(await readAll(path));
    expect(usage).toHaveLength(2);
    expect(usage[0]).toMatchObject({
      inputTokens: 40,
      totalTokens: 50,
      outputTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      reasoningTokens: null,
    });
    const deltas = cumulativeToDeltas(usage);
    expect(deltas[1]!.delta).toMatchObject({
      inputTokens: 30,
      totalTokens: 40,
      outputTokens: null,
      reasoningTokens: null,
    });
    expect(deltas[1]!.reset).toBe(false);
  });

  it("emits per-response deltas once per response id", async () => {
    const dir = makeStoreDir();
    const store = track(dir);
    const path = join(workdir(), "deltas.jsonl");
    ordinal = 0;
    writeFileSync(
      path,
      file([
        meta(),
        usageRecord("resp_a", counters(10, 2)),
        usageRecord("resp_a", counters(10, 2)),
        usageRecord("resp_b", counters(5, 1)),
        usageRecord(null, counters(7, 3)),
      ]),
    );
    const records = recordsOf(
      await drain(store, codexSource(source("codex-delta", 1), path)),
    );
    const usage = usageOf(records);
    expect(usage).toHaveLength(4);
    expect(usage.every((entry) => entry.basis === "delta")).toBe(true);
    expect(usage.every((entry) => entry.scopeKey === `codex:${SESSION}`)).toBe(
      true,
    );
    const unique = dedupeByKey(usage);
    expect(unique.map((entry) => entry.inputTokens)).toEqual([10, 5, 7]);
    expect(unique[0]!.dedupeKey).toBe("codex:usage:resp_a");
  });

  it("does not store usage or session records as searchable content", async () => {
    const dir = makeStoreDir();
    const store = track(dir);
    const path = join(workdir(), "unindexed.jsonl");
    ordinal = 0;
    writeFileSync(
      path,
      file([meta(), context("m1"), tokenCount(counters(10, 1))]),
    );
    const pages = await drain(
      store,
      codexSource(source("codex-unindexed", 1), path),
    );
    expect(recordsOf(pages)).toHaveLength(3);
    expect(count(dir, "content")).toBe(0);
  });
});

describe("model changes", () => {
  it("reports each turn_context model in order, including a missing one", async () => {
    const dir = makeStoreDir();
    const store = track(dir);
    const path = join(workdir(), "models.jsonl");
    ordinal = 0;
    writeFileSync(
      path,
      file([
        meta(),
        context("model-a"),
        message("user", "one"),
        context("model-b"),
        context(null),
        context("model-b"),
        message("user", "two"),
      ]),
    );
    const pages = await drain(
      store,
      codexSource(source("codex-models", 1), path),
      {
        maxRecords: 3,
        maxBytes: 2 * MIB,
        reserveBytes: 64 * 1024,
      } as PageBudget,
    );
    const sessions = ofKind(recordsOf(pages), "session");
    expect(sessions.map((entry) => entry.model)).toEqual([
      null,
      "model-a",
      "model-b",
      null,
      "model-b",
    ]);
    expect(sessions.every((entry) => entry.sessionId === SESSION)).toBe(true);
    expect(new Set(sessions.map((entry) => entry.dedupeKey)).size).toBe(5);
  });
});

describe("shared reader behaviors through the Codex adapter", () => {
  it("turns a streamed 5 MiB line into a placeholder, a quarantine row and a cursor advance, then reads the next line", async () => {
    const dir = makeStoreDir();
    const store = track(dir);
    const path = join(workdir(), "big.jsonl");
    ordinal = 0;
    const before = message("user", "before") + "\n";
    const after = message("user", "after") + "\n";
    const head =
      '{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"';
    const tail = '"}]}}\n';
    const hugeBody = 5 * MIB;
    const fd = openSync(path, "w");
    try {
      writeSync(fd, before);
      writeSync(fd, head);
      const chunk = Buffer.alloc(MIB, 0x61);
      let written = 0;
      const target = hugeBody - head.length - (tail.length - 1);
      while (written < target) {
        const take = Math.min(chunk.length, target - written);
        writeSync(fd, chunk, 0, take);
        written += take;
      }
      writeSync(fd, tail);
      writeSync(fd, after);
    } finally {
      closeSync(fd);
    }
    const ref = source("codex-big", 1);
    const src: CodexSource = { ref, path, sessionId: SESSION };

    const decodes: number[] = [];
    const parses: number[] = [];
    const stats = newReaderStats();
    let largestRead = 0;
    let bytesServed = 0;
    const deps: ReadPageDeps = {
      stats,
      decode(bytes) {
        decodes.push(bytes.length);
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      },
      parse(value) {
        parses.push(value.length);
        return JSON.parse(value) as unknown;
      },
      wrapChunkSource: (inner) => ({
        async read(position, into) {
          const read = await inner.read(position, into);
          bytesServed += read;
          largestRead = Math.max(largestRead, read);
          return read;
        },
      }),
    };

    const pages = await drain(store, src, undefined, deps);
    expect(pages.map((page) => page.status)).toEqual(["page", "page", "idle"]);
    const page = pages[0]!;
    const next = pages[1]!;
    if (page.status !== "page" || next.status !== "page") return;
    expect(page.batch.records).toHaveLength(1);
    expect(next.batch.records).toHaveLength(1);
    expect(page.batch.placeholders).toEqual([
      {
        kind: "oversized_record",
        dedupeKey: oversizedDedupeKey(1, before.length),
        startOffset: before.length,
        endOffset: before.length + hugeBody,
        byteLength: hugeBody,
        reason: "record_too_large",
      },
    ]);
    expect(page.progress.nextOffset).toBe(before.length + hugeBody + 1);
    expect(next.progress.nextOffset).toBe(
      before.length + hugeBody + 1 + after.length,
    );
    expect(Math.max(...decodes)).toBeLessThan(1024);
    expect(Math.max(...parses)).toBeLessThan(1024);
    expect(decodes).toHaveLength(2);
    expect(parses).toHaveLength(2);
    expect(stats.peakRetainedBytes).toBeLessThanOrEqual(4 * MIB);
    expect(largestRead).toBeLessThanOrEqual(64 * 1024);
    expect(bytesServed).toBeGreaterThanOrEqual(hugeBody);
    expect(quarantineRows(dir)).toEqual([
      {
        dedupe_key: oversizedDedupeKey(1, before.length),
        reason: "record_too_large",
        start_offset: before.length,
        end_offset: before.length + hugeBody,
        byte_length: hugeBody,
      },
    ]);
    expect(count(dir, "content")).toBe(2);
    expect(cursorOffsetOf(store, ref)).toBe(
      before.length + hugeBody + 1 + after.length,
    );
  });

  it("does not scan a 5 MiB first record to identify the session", async () => {
    const dir = makeStoreDir();
    const store = track(dir);
    const path = join(workdir(), `rollout-${SESSION}.jsonl`);
    const fd = openSync(path, "w");
    try {
      writeSync(fd, '{"type":"session_meta","payload":{"pad":"');
      writeSync(fd, Buffer.alloc(5 * MIB, 0x61));
      writeSync(fd, '"}}\n');
    } finally {
      closeSync(fd);
    }
    ordinal = 0;
    appendFileSync(path, file([tokenCount(counters(10, 1))]));
    const pages = await drain(
      store,
      codexSource(source("codex-big-meta", 1), path),
    );
    expect(pages[0]!.status).toBe("page");
    expect(usageOf(recordsOf(pages))[0]!.scopeKey).toBe(`codex:${SESSION}`);
  });

  it("skips blank, invalid and ignored lines but keeps reading", async () => {
    const dir = makeStoreDir();
    const store = track(dir);
    const path = join(workdir(), "mixed.jsonl");
    ordinal = 0;
    const lines = [
      message("user", "ok"),
      "",
      "{not json",
      rec("world_state", { full: true }),
      "[1,2,3]",
      message("user", "also ok"),
    ];
    writeFileSync(path, file(lines));
    const bad = Buffer.concat([
      Buffer.from('{"type":"response_item","payload":"\xff'),
      Buffer.from([0xff, 0xfe]),
      Buffer.from('"}\n'),
    ]);
    appendFileSync(path, bad);
    const ref = source("codex-mixed", 1);
    const pages = await drain(store, codexSource(ref, path));
    const first = pages[0]!;
    if (first.status !== "page") throw new Error("expected page");
    expect(
      ofKind(first.batch.records as NormalizedRecord[], "message"),
    ).toHaveLength(2);
    expect(first.skipped.invalidJson).toBeGreaterThanOrEqual(1);
    expect(first.skipped.blank).toBe(1);
    expect(first.skipped.ignored).toBeGreaterThanOrEqual(1);
    expect(count(dir, "content")).toBe(2);
    expect(pages[pages.length - 1]!.status).toBe("idle");
  });

  it("waits on a partial final line without advancing the durable cursor", async () => {
    const dir = makeStoreDir();
    const store = track(dir);
    const path = join(workdir(), "partial.jsonl");
    ordinal = 0;
    const first = message("user", "one") + "\n";
    const secondFull = message("user", "two");
    const half = Math.floor(secondFull.length / 2);
    writeFileSync(path, first + secondFull.slice(0, half));
    const ref = source("codex-partial", 1);
    const src: CodexSource = { ref, path, sessionId: SESSION };

    const page = await readCodexPage(src, null);
    if (page.status !== "page") throw new Error("expected page");
    expect(page.progress.waitingPartialBytes).toBe(half);
    expect(page.progress.nextOffset).toBe(first.length);
    committed(page, store);
    const durable = store.getCursor(ref);
    expect(cursorOffsetOf(store, ref)).toBe(first.length);

    const idle = await readCodexPage(src, durable);
    expect(idle.status).toBe("idle");
    expect(store.getCursor(ref)).toBe(durable);

    appendFileSync(path, secondFull.slice(half));
    expect((await readCodexPage(src, durable)).status).toBe("idle");

    appendFileSync(path, "\n");
    const done = await readCodexPage(src, durable);
    if (done.status !== "page") throw new Error("expected page");
    expect(done.batch.records).toHaveLength(1);
    committed(done, store);
    expect(count(dir, "content")).toBe(2);
  });

  it("does not create a cursor for a file that holds only a partial line", async () => {
    const dir = makeStoreDir();
    const store = track(dir);
    const path = join(workdir(), "only-partial.jsonl");
    writeFileSync(path, '{"type":"response_item"');
    const ref = source("codex-only-partial", 1);
    const page = await readCodexPage({ ref, path, sessionId: SESSION }, null);
    expect(page.status).toBe("idle");
    expect(store.getCursor(ref)).toBeNull();
  });

  it("reads only appended data after a restart", async () => {
    const dir = makeStoreDir();
    const store = track(dir);
    const path = join(workdir(), "append.jsonl");
    ordinal = 0;
    const first = file([meta(), message("user", "one")]);
    writeFileSync(path, first);
    const ref = source("codex-append", 1);
    const src = codexSource(ref, path);
    await drain(store, src);
    appendFileSync(
      path,
      file([message("user", "two"), tokenCount(counters(5, 1))]),
    );
    const page = await readCodexPage(src, store.getCursor(ref));
    if (page.status !== "page") throw new Error("expected page");
    expect(page.progress.startOffset).toBe(first.length);
    expect(page.batch.records).toHaveLength(2);
    expect(usageOf(page.batch.records as NormalizedRecord[])[0]!.scopeKey).toBe(
      `codex:${SESSION}`,
    );
    committed(page, store);
    expect(count(dir, "content")).toBe(2);
  });

  it("splits by record count and chains the cursor", async () => {
    const dir = makeStoreDir();
    const store = track(dir);
    const path = join(workdir(), "many.jsonl");
    ordinal = 0;
    const lines = [meta()];
    for (let i = 0; i < 25; i += 1) lines.push(message("user", `line ${i}`));
    writeFileSync(path, file(lines));
    const ref = source("codex-many-pages", 1);
    const pages = await drain(store, codexSource(ref, path), {
      maxRecords: 10,
      maxBytes: 2 * MIB,
      reserveBytes: 64 * 1024,
    } as PageBudget);
    expect(pages.map((page) => page.status)).toEqual([
      "page",
      "page",
      "page",
      "idle",
    ]);
    expect(count(dir, "content")).toBe(25);
  });

  it("leaves the cursor unchanged when the commit is refused and re-reads the same page", async () => {
    const dir = makeStoreDir();
    const store = track(dir);
    const path = join(workdir(), "refuse.jsonl");
    ordinal = 0;
    writeFileSync(path, file([meta(), message("user", "one")]));
    const ref = source("codex-refuse", 1);
    const src = codexSource(ref, path);
    const page = await readCodexPage(src, null);
    if (page.status !== "page") throw new Error("expected page");
    const refused = store.commitBatch(page.batch, {
      expected: "someone-else",
      next: page.cursor.next,
    });
    expect(refused.committed).toBe(false);
    expect(refused.refusal?.code).toBe("cursor_conflict");
    expect(store.getCursor(ref)).toBeNull();
    expect(count(dir, "content")).toBe(0);
    const again = await readCodexPage(src, store.getCursor(ref));
    expect(again).toEqual(page);
    committed(again, store);
    expect(count(dir, "content")).toBe(1);
  });

  it("reports a replaced file by inode and lets the caller restart on a new generation", async () => {
    const dir = makeStoreDir();
    const store = track(dir);
    const root = workdir();
    const path = join(root, "rotate.jsonl");
    ordinal = 0;
    writeFileSync(path, file([meta(), message("user", "old")]));
    const ref = source("codex-rotate", 1);
    await drain(store, codexSource(ref, path));
    const replacement = join(root, "replacement.jsonl");
    const fresh = file([
      meta(),
      message("user", "new"),
      message("user", "newer"),
    ]);
    writeFileSync(replacement, fresh);
    renameSync(replacement, path);

    expect(
      await readCodexPage(codexSource(ref, path), store.getCursor(ref)),
    ).toEqual({
      status: "invalidated",
      reason: "replaced",
    });
    const next = source("codex-rotate", 2);
    const pages = await drain(store, codexSource(next, path));
    expect(pages.map((entry) => entry.status)).toEqual(["page", "idle"]);
    expect(cursorOffsetOf(store, next)).toBe(Buffer.byteLength(fresh));
  });

  it("reports truncation below the cursor", async () => {
    const dir = makeStoreDir();
    const store = track(dir);
    const path = join(workdir(), "trunc.jsonl");
    ordinal = 0;
    writeFileSync(
      path,
      file([meta(), message("user", "one"), message("user", "two")]),
    );
    const ref = source("codex-trunc", 1);
    const src = codexSource(ref, path);
    await drain(store, src);
    truncateSync(path, 10);
    expect(await readCodexPage(src, store.getCursor(ref))).toEqual({
      status: "invalidated",
      reason: "truncated",
    });
  });

  it("detects truncate-and-regrow past the old cursor on the same inode", async () => {
    const dir = makeStoreDir();
    const store = track(dir);
    const path = join(workdir(), "regrow.jsonl");
    ordinal = 0;
    const data = file([meta(), message("user", "one"), message("user", "two")]);
    writeFileSync(path, data);
    const ref = source("codex-regrow", 1);
    const src = codexSource(ref, path);
    await drain(store, src);
    const durable = store.getCursor(ref);
    truncateSync(path, 0);
    const replacement = file([
      meta("44444444-4444-4444-8444-444444444444"),
      message("user", "ONE"),
      message("user", "TWO"),
      message("user", "three"),
      message("user", "four"),
    ]);
    writeFileSync(path, replacement);
    expect(Buffer.byteLength(replacement)).toBeGreaterThan(
      Buffer.byteLength(data),
    );
    expect(await readCodexPage(src, durable)).toEqual({
      status: "invalidated",
      reason: "rewritten",
    });
  });

  it("detects an in-place rewrite of the bytes before the cursor", async () => {
    const dir = makeStoreDir();
    const store = track(dir);
    const path = join(workdir(), "inplace.jsonl");
    ordinal = 0;
    const data = file([meta(), message("user", "one")]);
    writeFileSync(path, data);
    const ref = source("codex-inplace", 1);
    const src = codexSource(ref, path);
    await drain(store, src);
    const mutated = Buffer.from(data);
    mutated[10] = mutated[10]! ^ 0x01;
    writeFileSync(
      path,
      Buffer.concat([mutated, Buffer.from(file([message("user", "x")]))]),
    );
    expect(await readCodexPage(src, store.getCursor(ref))).toEqual({
      status: "invalidated",
      reason: "rewritten",
    });
  });

  it("reports missing files, directories and unreadable cursors", async () => {
    const root = workdir();
    const ref = source("codex-odd", 1);
    expect(
      await readCodexPage(codexSource(ref, join(root, "absent.jsonl")), null),
    ).toEqual({ status: "invalidated", reason: "missing" });
    const directory = join(root, "dir");
    mkdirSync(directory);
    expect(await readCodexPage(codexSource(ref, directory), null)).toEqual({
      status: "invalidated",
      reason: "not_regular_file",
    });
    const path = join(root, "f.jsonl");
    writeFileSync(path, "\n");
    expect(await readCodexPage(codexSource(ref, path), "garbage")).toEqual({
      status: "invalidated",
      reason: "unreadable_cursor",
    });
    expect(
      await readCodexPage(
        codexSource(ref, path),
        `${CODEX_CURSOR_PREFIX}:1:2:3:4:x:5:y`,
      ),
    ).toMatchObject({ status: "invalidated" });
  });

  it("rejects a cursor minted by the other provider's adapter", async () => {
    const dir = makeStoreDir();
    const store = track(dir);
    const root = workdir();
    const path = join(root, "shared.jsonl");
    ordinal = 0;
    writeFileSync(path, file([meta(), message("user", "one")]));
    const claudeRef = source("claude-side", 1);
    const claudePage = await readClaudePage({ ref: claudeRef, path }, null);
    if (claudePage.status !== "page") throw new Error("expected page");
    const codexRef = source("codex-side", 1);
    expect(
      await readCodexPage(codexSource(codexRef, path), claudePage.cursor.next),
    ).toEqual({ status: "invalidated", reason: "unreadable_cursor" });

    const codexPage = await readCodexPage(codexSource(codexRef, path), null);
    if (codexPage.status !== "page") throw new Error("expected page");
    expect(codexPage.cursor.next.startsWith(`${CODEX_CURSOR_PREFIX}:`)).toBe(
      true,
    );
    expect(
      await readClaudePage({ ref: claudeRef, path }, codexPage.cursor.next),
    ).toEqual({ status: "invalidated", reason: "unreadable_cursor" });
    expect(store.getCursor(codexRef)).toBeNull();
    expect(count(dir, "content")).toBe(0);
  });

  it("keeps cursors within the store's size limit", async () => {
    const path = join(workdir(), "cursor.jsonl");
    ordinal = 0;
    writeFileSync(path, file([meta(), message("user", "one")]));
    const page = await readCodexPage(codexSource(source("c", 1), path), null);
    if (page.status !== "page") throw new Error("expected page");
    expect(Buffer.byteLength(page.cursor.next)).toBeLessThanOrEqual(4096);
    expect(decodeCodexCursor(page.cursor.next)).not.toBeNull();
    expect(codexCursorOffset(page.cursor.next)).toBe(page.progress.nextOffset);
    expect(codexCursorOffset(null)).toBe(0);
    expect(codexCursorOffset("claude1:1:2:3:4:x:5:y")).toBeNull();
  });

  it("copies the fixture byte for byte when read from a temporary path", async () => {
    const path = join(workdir(), `rollout-${codexSessionId}.jsonl`);
    copyFileSync(fixturePath("codex/rollout.jsonl"), path);
    const records = await readAll(path);
    expect(ofKind(records, "message")).toHaveLength(2);
  });
});
