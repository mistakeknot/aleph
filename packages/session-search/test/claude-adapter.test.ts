import {
  appendFileSync,
  closeSync,
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

import {
  decodeCursor,
  readPage,
  type ClaudeSource,
  type PageBudget,
  type ReadPageDeps,
  type SourcePage,
} from "../src/adapters/claude.js";
import { oversizedDedupeKey } from "../src/admission.js";
import {
  openReadonlyConnection,
  type CommitResult,
  type SessionSearchStore,
  type SourceRef,
} from "../src/storage.js";
import { newReaderStats } from "../src/streaming-reader.js";
import {
  cleanupStoreDirs,
  makeStoreDir,
  openTestStore,
  source,
} from "./support/store-helpers.js";

const MIB = 1024 * 1024;
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
  const dir = mkdtempSync(join(tmpdir(), "ss-claude-"));
  dirs.push(dir);
  return dir;
}

function line(uuid: string, text: string): string {
  return JSON.stringify({
    type: "user",
    uuid,
    sessionId: "s1",
    timestamp: "2026-01-01T00:00:00.000Z",
    cwd: "/work/fixture",
    message: { role: "user", content: text },
  });
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

function claudeSource(ref: SourceRef, path: string): ClaudeSource {
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
  src: ClaudeSource,
  budget?: PageBudget,
  deps?: ReadPageDeps,
): Promise<SourcePage[]> {
  const pages: SourcePage[] = [];
  for (let guard = 0; guard < 10_000; guard += 1) {
    const page = await readPage(src, store.getCursor(src.ref), budget, deps);
    pages.push(page);
    if (page.status !== "page") return pages;
    committed(page, store);
  }
  throw new Error("drain did not terminate");
}

function cursorOffsetOf(store: SessionSearchStore, ref: SourceRef): number {
  const cursor = store.getCursor(ref);
  if (cursor === null) throw new Error("no cursor");
  return decodeCursor(cursor)!.offset;
}

describe("readPage with the real store", () => {
  it("indexes lines, advances the cursor, and replays idempotently", async () => {
    const dir = makeStoreDir();
    const store = track(dir);
    const path = join(workdir(), "a.jsonl");
    const data = [line("u1", "alpha"), line("u2", "beta")].join("\n") + "\n";
    writeFileSync(path, data);
    const ref = source("claude-a", 1);
    const src = claudeSource(ref, path);

    const first = await readPage(src, null);
    expect(first.status).toBe("page");
    if (first.status !== "page") return;
    expect(first.progress).toMatchObject({
      startOffset: 0,
      nextOffset: data.length,
      lines: 2,
      recordCount: 2,
      placeholderCount: 0,
      waitingPartialBytes: 0,
      endOfFile: true,
    });
    expect(first.cursor.expected).toBeNull();
    const result = committed(first, store);
    expect(result.inserted).toBe(2);
    expect(count(dir, "content")).toBe(2);
    expect(cursorOffsetOf(store, ref)).toBe(data.length);

    const second = await readPage(src, store.getCursor(ref));
    expect(second.status).toBe("idle");
    expect(second.status === "idle" && second.progress.nextOffset).toBe(
      data.length,
    );

    const replay = store.commitBatch(first.batch, {
      expected: null,
      next: first.cursor.next,
    });
    expect(replay.committed).toBe(false);
    expect(replay.refusal?.code).toBe("cursor_conflict");
    expect(count(dir, "content")).toBe(2);
  });

  it("turns a streamed 5 MiB line into a placeholder, a quarantine row and a cursor advance, then reads the next line", async () => {
    const dir = makeStoreDir();
    const store = track(dir);
    const path = join(workdir(), "big.jsonl");
    const before = line("u1", "before") + "\n";
    const after = line("u3", "after") + "\n";
    const hugeBody = 5 * MIB;
    const fd = openSync(path, "w");
    try {
      writeSync(fd, before);
      writeSync(fd, '{"type":"user","message":{"content":"');
      const chunk = Buffer.alloc(MIB, 0x61);
      let written = 0;
      const target =
        hugeBody - '{"type":"user","message":{"content":"'.length - 3;
      while (written < target) {
        const take = Math.min(chunk.length, target - written);
        writeSync(fd, chunk, 0, take);
        written += take;
      }
      writeSync(fd, '"}}\n');
      writeSync(fd, after);
    } finally {
      closeSync(fd);
    }
    const ref = source("claude-big", 1);
    const src = claudeSource(ref, path);

    const decodes: number[] = [];
    const parses: number[] = [];
    const stats = newReaderStats();
    let bytesServed = 0;
    let largestRead = 0;
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
    expect(next.batch.placeholders).toEqual([]);
    expect(next.progress.startOffset).toBe(before.length + hugeBody + 1);
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
    expect(stats.largestDecodedBytes).toBeLessThan(1024);
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
  }, 60_000);

  it("keeps a record whose text is over the store ceiling out of the index without blocking later lines", async () => {
    const dir = makeStoreDir();
    const store = track(dir);
    const path = join(workdir(), "mid.jsonl");
    const data =
      [
        line("u1", "small"),
        line("u2", "z".repeat(2 * MIB)),
        line("u3", "tail"),
      ].join("\n") + "\n";
    writeFileSync(path, data);
    const ref = source("claude-mid", 1);
    const pages = await drain(store, claudeSource(ref, path));
    expect(pages.map((page) => page.status)).toEqual(["page", "page", "idle"]);
    expect(count(dir, "content")).toBe(2);
    expect(quarantineRows(dir)).toHaveLength(1);
    expect(cursorOffsetOf(store, ref)).toBe(Buffer.byteLength(data));
  });

  it("skips blank, invalid utf-8 and invalid json lines and still advances", async () => {
    const dir = makeStoreDir();
    const store = track(dir);
    const path = join(workdir(), "mixed.jsonl");
    const data = Buffer.concat([
      Buffer.from(line("u1", "one") + "\n"),
      Buffer.from("\n"),
      Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x7d, 0x0a]),
      Buffer.from("{broken\n"),
      Buffer.from(JSON.stringify({ type: "summary" }) + "\n"),
      Buffer.from(line("u2", "two") + "\n"),
    ]);
    writeFileSync(path, data);
    const ref = source("claude-mixed", 1);
    const src = claudeSource(ref, path);
    const page = await readPage(src, null);
    if (page.status !== "page") throw new Error("expected page");
    expect(page.skipped).toMatchObject({
      blank: 1,
      invalidUtf8: 1,
      invalidJson: 1,
      ignored: 1,
    });
    expect(page.skipped.samples.map((sample) => sample.reason)).toEqual([
      "invalid_utf8",
      "invalid_json",
      "ignored",
    ]);
    expect(page.batch.records).toHaveLength(2);
    committed(page, store);
    expect(cursorOffsetOf(store, ref)).toBe(data.length);
    expect(count(dir, "content")).toBe(2);
  });

  it("advances the cursor over a page that holds only skipped lines", async () => {
    const dir = makeStoreDir();
    const store = track(dir);
    const path = join(workdir(), "blank.jsonl");
    writeFileSync(path, "\n\n{nope\n");
    const ref = source("claude-blank", 1);
    const src = claudeSource(ref, path);
    const page = await readPage(src, null);
    if (page.status !== "page") throw new Error("expected page");
    expect(page.batch.records).toEqual([]);
    committed(page, store);
    expect(cursorOffsetOf(store, ref)).toBe(8);
    expect((await readPage(src, store.getCursor(ref))).status).toBe("idle");
    expect(count(dir, "content")).toBe(0);
  });

  it("waits on a partial final line without advancing the durable cursor", async () => {
    const dir = makeStoreDir();
    const store = track(dir);
    const path = join(workdir(), "partial.jsonl");
    const first = line("u1", "one") + "\n";
    const secondFull = line("u2", "two");
    const half = Math.floor(secondFull.length / 2);
    writeFileSync(path, first + secondFull.slice(0, half));
    const ref = source("claude-partial", 1);
    const src = claudeSource(ref, path);

    const page = await readPage(src, null);
    if (page.status !== "page") throw new Error("expected page");
    expect(page.progress.waitingPartialBytes).toBe(half);
    expect(page.progress.nextOffset).toBe(first.length);
    committed(page, store);
    const durable = store.getCursor(ref);
    expect(cursorOffsetOf(store, ref)).toBe(first.length);

    const idle = await readPage(src, durable);
    expect(idle.status).toBe("idle");
    expect(idle.status === "idle" && idle.progress.waitingPartialBytes).toBe(
      half,
    );
    expect(store.getCursor(ref)).toBe(durable);

    appendFileSync(path, secondFull.slice(half));
    const stillWaiting = await readPage(src, durable);
    expect(stillWaiting.status).toBe("idle");

    appendFileSync(path, "\n");
    const done = await readPage(src, durable);
    if (done.status !== "page") throw new Error("expected page");
    expect(done.batch.records).toHaveLength(1);
    committed(done, store);
    expect(count(dir, "content")).toBe(2);
  });

  it("does not create a cursor for a file that holds only a partial line", async () => {
    const dir = makeStoreDir();
    const store = track(dir);
    const path = join(workdir(), "only-partial.jsonl");
    writeFileSync(path, '{"type":"user"');
    const ref = source("claude-only-partial", 1);
    const page = await readPage(claudeSource(ref, path), null);
    expect(page.status).toBe("idle");
    expect(store.getCursor(ref)).toBeNull();
  });

  it("reads only appended data after a restart", async () => {
    const dir = makeStoreDir();
    const store = track(dir);
    const path = join(workdir(), "append.jsonl");
    const first = line("u1", "one") + "\n";
    writeFileSync(path, first);
    const ref = source("claude-append", 1);
    const src = claudeSource(ref, path);
    await drain(store, src);
    const second = line("u2", "two") + "\n";
    appendFileSync(path, second);
    const page = await readPage(src, store.getCursor(ref));
    if (page.status !== "page") throw new Error("expected page");
    expect(page.progress.startOffset).toBe(first.length);
    expect(page.batch.records).toHaveLength(1);
    committed(page, store);
    expect(count(dir, "content")).toBe(2);
  });

  it("splits a long file into pages by record count and chains the cursor", async () => {
    const dir = makeStoreDir();
    const store = track(dir);
    const path = join(workdir(), "many.jsonl");
    const lines = Array.from({ length: 10 }, (_, index) =>
      line(`u${index}`, `message ${index}`),
    );
    writeFileSync(path, lines.join("\n") + "\n");
    const ref = source("claude-many", 1);
    const pages = await drain(store, claudeSource(ref, path), {
      maxBytes: 10 * MIB,
      maxRecords: 3,
    });
    expect(pages.map((page) => page.status)).toEqual([
      "page",
      "page",
      "page",
      "page",
      "idle",
    ]);
    const sizes = pages
      .filter((page) => page.status === "page")
      .map((page) => (page.status === "page" ? page.batch.records.length : 0));
    expect(sizes).toEqual([3, 3, 3, 1]);
    expect(count(dir, "content")).toBe(10);
  });

  it("splits pages by byte budget", async () => {
    const dir = makeStoreDir();
    const store = track(dir);
    const path = join(workdir(), "bytes.jsonl");
    const one = line("u0", "x".repeat(500));
    const lines = Array.from({ length: 8 }, (_, index) =>
      line(`u${index}`, "x".repeat(500)),
    );
    writeFileSync(path, lines.join("\n") + "\n");
    const ref = source("claude-bytes", 1);
    const pages = await drain(store, claudeSource(ref, path), {
      maxBytes: one.length * 2,
      maxRecords: 1000,
    });
    const statuses = pages.map((page) => page.status);
    expect(statuses.at(-1)).toBe("idle");
    expect(statuses.filter((status) => status === "page")).toHaveLength(4);
    expect(count(dir, "content")).toBe(8);
  });

  it("splits pages by accounted batch size and replaces an unadmittable record with a placeholder", async () => {
    const dir = makeStoreDir();
    const store = track(dir);
    const path = join(workdir(), "limits.jsonl");
    const lines = [
      line("u0", "a".repeat(2000)),
      line("u1", "b".repeat(2000)),
      line("u2", "c".repeat(300_000)),
      line("u3", "d".repeat(2000)),
    ];
    writeFileSync(path, lines.join("\n") + "\n");
    const ref = source("claude-limits", 1);
    const base = 64 * 1024;
    const pages = await drain(store, claudeSource(ref, path), {
      maxBytes: 10 * MIB,
      maxRecords: 1000,
      limits: {
        maxBatchInputBytes: base + 4500,
        maxBatchAccountedBytes: base + 64_000,
        maxDepth: 32,
        valueAllowanceBytes: 128,
      },
    });
    const withPages = pages.filter((page) => page.status === "page");
    expect(withPages.length).toBeGreaterThan(1);
    expect(pages.at(-1)!.status).toBe("idle");
    expect(count(dir, "content")).toBe(3);
    expect(quarantineRows(dir)).toEqual([
      {
        dedupe_key: oversizedDedupeKey(
          1,
          lines[0]!.length + lines[1]!.length + 2,
        ),
        reason: "record_too_large",
        start_offset: lines[0]!.length + lines[1]!.length + 2,
        end_offset: lines[0]!.length + lines[1]!.length + 2 + lines[2]!.length,
        byte_length: lines[2]!.length,
      },
    ]);
  });

  it("replaces a line that yields more records than a page may hold", async () => {
    const dir = makeStoreDir();
    const store = track(dir);
    const path = join(workdir(), "fanout.jsonl");
    const fanout = JSON.stringify({
      type: "user",
      uuid: "fan",
      sessionId: "s1",
      timestamp: "2026-01-01T00:00:00.000Z",
      message: {
        role: "user",
        content: Array.from({ length: 5 }, (_, index) => ({
          type: "text",
          text: `block ${index}`,
        })),
      },
    });
    writeFileSync(path, fanout + "\n" + line("u1", "after") + "\n");
    const ref = source("claude-fanout", 1);
    await drain(store, claudeSource(ref, path), {
      maxBytes: 10 * MIB,
      maxRecords: 3,
    });
    expect(count(dir, "content")).toBe(1);
    expect(quarantineRows(dir)).toHaveLength(1);
  });

  it("quarantines a deeply nested tool input and still ingests the next line", async () => {
    const dir = makeStoreDir();
    const store = track(dir);
    const path = join(workdir(), "deep.jsonl");
    const depth = 10_000;
    const nested = '{"a":'.repeat(depth) + "1" + "}".repeat(depth);
    const deep =
      '{"type":"assistant","uuid":"deep","sessionId":"s1","timestamp":"2026-01-01T00:00:00.000Z","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Edit","input":' +
      nested +
      "}]}}";
    expect(deep.length).toBeGreaterThan(50_000);
    expect(() => JSON.parse(deep)).not.toThrow();
    writeFileSync(
      path,
      line("u0", "before") + "\n" + deep + "\n" + line("u1", "after") + "\n",
    );
    const ref = source("claude-deep", 1);
    const pages = await drain(store, claudeSource(ref, path));
    expect(pages.map((page) => page.status)).toEqual(["page", "idle"]);
    expect(count(dir, "content")).toBe(2);
    const rows = quarantineRows(dir);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      reason: "record_too_large",
      byte_length: deep.length,
    });
    expect(cursorOffsetOf(store, ref)).toBe(
      Buffer.byteLength(
        line("u0", "before") + "\n" + deep + "\n" + line("u1", "after") + "\n",
      ),
    );
  });

  it("quarantines a record nested just past the depth limit and keeps reading", async () => {
    const dir = makeStoreDir();
    const store = track(dir);
    const path = join(workdir(), "shallow-deep.jsonl");
    const nested = "[".repeat(40) + "]".repeat(40);
    const over = `{"type":"user","uuid":"over","sessionId":"s1","timestamp":"2026-01-01T00:00:00.000Z","message":{"role":"user","content":"x"},"extra":${nested}}`;
    writeFileSync(path, over + "\n" + line("u1", "after") + "\n");
    const ref = source("claude-over", 1);
    await drain(store, claudeSource(ref, path));
    expect(count(dir, "content")).toBe(1);
    expect(quarantineRows(dir)).toHaveLength(1);
  });

  it("leaves the cursor unchanged when the commit is refused and re-reads the same page", async () => {
    const dir = makeStoreDir();
    const store = track(dir);
    const path = join(workdir(), "refuse.jsonl");
    writeFileSync(path, line("u1", "one") + "\n");
    const ref = source("claude-refuse", 1);
    const src = claudeSource(ref, path);
    const page = await readPage(src, null);
    if (page.status !== "page") throw new Error("expected page");
    const refused = store.commitBatch(page.batch, {
      expected: "someone-else",
      next: page.cursor.next,
    });
    expect(refused.committed).toBe(false);
    expect(store.getCursor(ref)).toBeNull();
    expect(count(dir, "content")).toBe(0);
    const again = await readPage(src, store.getCursor(ref));
    expect(again).toEqual(page);
    committed(again, store);
    expect(count(dir, "content")).toBe(1);
  });

  it("reports a replaced file by inode and lets the caller restart on a new generation", async () => {
    const dir = makeStoreDir();
    const store = track(dir);
    const root = workdir();
    const path = join(root, "rotate.jsonl");
    writeFileSync(path, line("u1", "old") + "\n");
    const ref = source("claude-rotate", 1);
    await drain(store, claudeSource(ref, path));
    const replacement = join(root, "replacement.jsonl");
    const fresh = line("u9", "new") + "\n";
    writeFileSync(replacement, fresh.repeat(3));
    renameSync(replacement, path);

    const page = await readPage(claudeSource(ref, path), store.getCursor(ref));
    expect(page).toEqual({ status: "invalidated", reason: "replaced" });

    const next = source("claude-rotate", 2);
    const pages = await drain(store, claudeSource(next, path));
    expect(pages.map((entry) => entry.status)).toEqual(["page", "idle"]);
    expect(cursorOffsetOf(store, next)).toBe(fresh.length * 3);
  });

  it("reports truncation below the cursor", async () => {
    const dir = makeStoreDir();
    const store = track(dir);
    const path = join(workdir(), "trunc.jsonl");
    const data = [line("u1", "one"), line("u2", "two")].join("\n") + "\n";
    writeFileSync(path, data);
    const ref = source("claude-trunc", 1);
    const src = claudeSource(ref, path);
    await drain(store, src);
    truncateSync(path, 10);
    expect(await readPage(src, store.getCursor(ref))).toEqual({
      status: "invalidated",
      reason: "truncated",
    });
  });

  it("detects truncate-and-regrow past the old cursor on the same inode", async () => {
    const dir = makeStoreDir();
    const store = track(dir);
    const path = join(workdir(), "regrow.jsonl");
    const data = [line("u1", "one"), line("u2", "two")].join("\n") + "\n";
    writeFileSync(path, data);
    const ref = source("claude-regrow", 1);
    const src = claudeSource(ref, path);
    await drain(store, src);
    const durable = store.getCursor(ref);
    truncateSync(path, 0);
    const replacement = [line("v1", "ONE"), line("v2", "TWO"), line("v3", "3")]
      .join("\n")
      .concat("\n");
    writeFileSync(path, replacement);
    expect(Buffer.byteLength(replacement)).toBeGreaterThan(
      Buffer.byteLength(data),
    );
    expect(await readPage(src, durable)).toEqual({
      status: "invalidated",
      reason: "rewritten",
    });
  });

  it("detects an in-place rewrite of the bytes before the cursor", async () => {
    const dir = makeStoreDir();
    const store = track(dir);
    const path = join(workdir(), "inplace.jsonl");
    const data = line("u1", "one") + "\n";
    writeFileSync(path, data);
    const ref = source("claude-inplace", 1);
    const src = claudeSource(ref, path);
    await drain(store, src);
    const mutated = Buffer.from(data);
    mutated[10] = mutated[10]! ^ 0x01;
    writeFileSync(
      path,
      Buffer.concat([mutated, Buffer.from(line("u2", "x") + "\n")]),
    );
    expect(await readPage(src, store.getCursor(ref))).toEqual({
      status: "invalidated",
      reason: "rewritten",
    });
  });

  it("reports missing files, directories and unreadable cursors", async () => {
    const root = workdir();
    const ref = source("claude-odd", 1);
    expect(
      await readPage(claudeSource(ref, join(root, "absent.jsonl")), null),
    ).toEqual({ status: "invalidated", reason: "missing" });
    const directory = join(root, "dir");
    mkdirSync(directory);
    expect(await readPage(claudeSource(ref, directory), null)).toEqual({
      status: "invalidated",
      reason: "not_regular_file",
    });
    const path = join(root, "f.jsonl");
    writeFileSync(path, "\n");
    expect(await readPage(claudeSource(ref, path), "garbage")).toEqual({
      status: "invalidated",
      reason: "unreadable_cursor",
    });
    expect(
      await readPage(claudeSource(ref, path), "claude1:1:2:3:4:x:5:y"),
    ).toMatchObject({ status: "invalidated" });
  });

  it("keeps cursors within the store's size limit", async () => {
    const path = join(workdir(), "cursor.jsonl");
    writeFileSync(path, line("u1", "one") + "\n");
    const page = await readPage(claudeSource(source("c", 1), path), null);
    if (page.status !== "page") throw new Error("expected page");
    expect(Buffer.byteLength(page.cursor.next)).toBeLessThanOrEqual(4096);
    expect(decodeCursor(page.cursor.next)).not.toBeNull();
  });
});
