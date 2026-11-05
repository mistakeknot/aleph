import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";

import { afterAll, describe, expect, it } from "vitest";

import { dedupeByKey, normalize, readJsonlFile } from "../src/index.js";
import { codexSessionId, fixturePath, normalizeFixture } from "./helpers.js";

const scratch = mkdtempSync(join(tmpdir(), "session-search-reader-"));
const zstRollout = join(scratch, "rollout.jsonl.zst");
writeFileSync(
  zstRollout,
  zstdCompressSync(readFileSync(fixturePath("codex/rollout.jsonl"))),
);

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("readJsonlFile", () => {
  it("reads plain and zstd rollouts to identical records", async () => {
    const plain = await readJsonlFile(fixturePath("codex/rollout.jsonl"));
    const packed = await readJsonlFile(zstRollout);
    expect(plain.compressed).toBe(false);
    expect(packed.compressed).toBe(true);
    expect(packed.records).toEqual(plain.records);
    expect(packed.logicalBytes).toBe(plain.logicalBytes);
    expect(packed.malformedLines).toBe(0);
    expect(packed.truncated).toBe(false);
  });

  it("normalizes a zstd rollout exactly like the plain rollout", async () => {
    const source = { provider: "codex", sessionId: codexSessionId } as const;
    const packed = await readJsonlFile(zstRollout);
    const fromZst = packed.records.flatMap((record) =>
      normalize(record, source),
    );
    expect(fromZst).toEqual(normalizeFixture("codex/rollout.jsonl", source));
    expect(dedupeByKey(fromZst)).toHaveLength(fromZst.length);
  });

  it("detects zstd by content, not by file name", async () => {
    const path = join(scratch, "rollout-without-extension");
    writeFileSync(path, zstdCompressSync(Buffer.from('{"a":1}\n{"b":2}\n')));
    const result = await readJsonlFile(path);
    expect(result.compressed).toBe(true);
    expect(result.records).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("counts malformed lines and handles a missing final newline", async () => {
    const path = join(scratch, "partial.jsonl");
    writeFileSync(path, '{"a":1}\r\n{broken\n{"b":2}');
    const result = await readJsonlFile(path);
    expect(result.records).toEqual([{ a: 1 }, { b: 2 }]);
    expect(result.malformedLines).toBe(1);
  });

  it("stops at the logical byte cap and reports truncation", async () => {
    const path = join(scratch, "big.jsonl.zst");
    const lines = Array.from({ length: 200 }, (_, index) =>
      JSON.stringify({ index }),
    );
    writeFileSync(path, zstdCompressSync(Buffer.from(`${lines.join("\n")}\n`)));
    const result = await readJsonlFile(path, { maxLogicalBytes: 100 });
    expect(result.truncated).toBe(true);
    expect(result.logicalBytes).toBe(100);
    expect(result.records.length).toBeGreaterThan(0);
    expect(result.records.length).toBeLessThan(200);
  });

  it("decodes multibyte characters split across chunk boundaries", async () => {
    const path = join(scratch, "unicode.jsonl");
    const text = "é".repeat(70000);
    writeFileSync(path, `${JSON.stringify({ text })}\n`);
    const result = await readJsonlFile(path);
    expect(result.records).toEqual([{ text }]);
  });
});
