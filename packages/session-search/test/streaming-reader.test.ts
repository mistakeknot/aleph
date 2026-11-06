import { describe, expect, it } from "vitest";

import { oversizedDedupeKey } from "../src/admission.js";
import {
  MAX_LINE_BYTES,
  newReaderStats,
  scanLines,
  type ChunkSource,
  type LineDeps,
  type LineItem,
  type ReaderStats,
  type ScanEnd,
} from "../src/streaming-reader.js";
import {
  bufferSource,
  fill,
  segmentSource,
  text,
  type CountingSource,
} from "./support/chunk-sources.js";

const MIB = 1024 * 1024;
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

interface Observed {
  decodes: number[];
  parses: number[];
  deps: Partial<LineDeps>;
}

function observe(): Observed {
  const decodes: number[] = [];
  const parses: number[] = [];
  return {
    decodes,
    parses,
    deps: {
      decode(bytes) {
        decodes.push(bytes.length);
        return utf8.decode(bytes);
      },
      parse(value) {
        parses.push(value.length);
        return JSON.parse(value) as unknown;
      },
    },
  };
}

async function collect(
  source: ChunkSource,
  options: Parameters<typeof scanLines>[1],
): Promise<{ items: LineItem[]; end: ScanEnd }> {
  const iterator = scanLines(source, options);
  const items: LineItem[] = [];
  for (;;) {
    const step = await iterator.next();
    if (step.done) return { items, end: step.value };
    items.push(step.value);
  }
}

function assertNoLargeMaterialization(
  observed: Observed,
  stats: ReaderStats,
  ceiling: number,
): void {
  const largestDecode = Math.max(0, ...observed.decodes);
  const largestParse = Math.max(0, ...observed.parses);
  if (largestDecode > ceiling) {
    throw new Error(`decoded ${largestDecode} bytes in one call`);
  }
  if (largestParse > ceiling) {
    throw new Error(`parsed ${largestParse} characters in one call`);
  }
  if (stats.largestDecodedBytes > ceiling) {
    throw new Error(`stats saw a ${stats.largestDecodedBytes} byte decode`);
  }
}

async function naiveScan(
  source: ChunkSource,
  deps: Partial<LineDeps>,
): Promise<number> {
  const buffer = Buffer.allocUnsafe(64 * 1024);
  const pieces: Buffer[] = [];
  let position = 0;
  for (;;) {
    const read = await source.read(position, buffer);
    if (read <= 0) break;
    pieces.push(Buffer.from(buffer.subarray(0, read)));
    position += read;
  }
  const whole = Buffer.concat(pieces);
  let failures = 0;
  let start = 0;
  while (start < whole.length) {
    let end = whole.indexOf(0x0a, start);
    if (end === -1) end = whole.length;
    const line = whole.subarray(start, end);
    try {
      deps.parse!(deps.decode!(line));
    } catch {
      failures += 1;
    }
    start = end + 1;
  }
  return failures;
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

describe("scanLines", () => {
  it("yields exact offsets for lines split across tiny chunks", async () => {
    const lines = [json({ a: 1 }), json({ b: "two" }), json({ c: [3] })];
    const data = Buffer.from(lines.join("\n") + "\n");
    for (const chunkBytes of [1, 3, 7, 64]) {
      const { items, end } = await collect(bufferSource(data), {
        startOffset: 0,
        generation: 1,
        chunkBytes,
      });
      let offset = 0;
      const expected = lines.map((line) => {
        const item = {
          kind: "record",
          startOffset: offset,
          endOffset: offset + line.length,
          nextOffset: offset + line.length + 1,
          value: JSON.parse(line) as unknown,
        };
        offset += line.length + 1;
        return item;
      });
      expect(items).toEqual(expected);
      expect(end).toEqual({ nextOffset: data.length, partialBytes: 0 });
    }
  });

  it("starts from a nonzero offset", async () => {
    const first = json({ a: 1 }) + "\n";
    const second = json({ b: 2 }) + "\n";
    const { items } = await collect(bufferSource(Buffer.from(first + second)), {
      startOffset: first.length,
      generation: 1,
    });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "record",
      startOffset: first.length,
      value: { b: 2 },
    });
  });

  it("skips blank lines, invalid utf-8 and invalid json while advancing", async () => {
    const data = Buffer.concat([
      Buffer.from("\n"),
      Buffer.from("  \t\r\n"),
      Buffer.from([0x7b, 0x22, 0xff, 0xfe, 0x22, 0x7d, 0x0a]),
      Buffer.from("{not json\n"),
      Buffer.from(json({ ok: true }) + "\n"),
    ]);
    const { items, end } = await collect(bufferSource(data), {
      startOffset: 0,
      generation: 1,
      chunkBytes: 5,
    });
    expect(
      items.map((item) => (item.kind === "skipped" ? item.reason : item.kind)),
    ).toEqual(["blank", "blank", "invalid_utf8", "invalid_json", "record"]);
    expect(items.at(-1)).toMatchObject({ value: { ok: true } });
    expect(end.nextOffset).toBe(data.length);
    expect(end.partialBytes).toBe(0);
  });

  it("does not parse a line that fails utf-8 decoding", async () => {
    const observed = observe();
    await collect(bufferSource(Buffer.from([0x7b, 0xff, 0x7d, 0x0a])), {
      startOffset: 0,
      generation: 1,
      deps: observed.deps,
    });
    expect(observed.decodes).toEqual([3]);
    expect(observed.parses).toEqual([]);
  });

  it("leaves an incomplete final line unyielded and unconsumed", async () => {
    const complete = json({ a: 1 }) + "\n";
    const partial = '{"b":';
    const { items, end } = await collect(
      bufferSource(Buffer.from(complete + partial)),
      { startOffset: 0, generation: 1, chunkBytes: 4 },
    );
    expect(items).toHaveLength(1);
    expect(end).toEqual({
      nextOffset: complete.length,
      partialBytes: partial.length,
    });
  });

  it("does not parse or decode an incomplete final line", async () => {
    const observed = observe();
    await collect(bufferSource(Buffer.from('{"a":1}\n{"b"')), {
      startOffset: 0,
      generation: 1,
      deps: observed.deps,
    });
    expect(observed.decodes).toEqual([7]);
  });

  it("treats a file that ends exactly on a newline as fully consumed", async () => {
    const data = Buffer.from(json({ a: 1 }) + "\n");
    const { end } = await collect(bufferSource(data), {
      startOffset: 0,
      generation: 1,
    });
    expect(end).toEqual({ nextOffset: data.length, partialBytes: 0 });
  });

  it("returns nothing for an empty source and for a start at end of file", async () => {
    expect(
      await collect(bufferSource(Buffer.alloc(0)), {
        startOffset: 0,
        generation: 1,
      }),
    ).toEqual({ items: [], end: { nextOffset: 0, partialBytes: 0 } });
    const data = Buffer.from("{}\n");
    expect(
      await collect(bufferSource(data), { startOffset: 3, generation: 1 }),
    ).toEqual({ items: [], end: { nextOffset: 3, partialBytes: 0 } });
  });

  it("accepts a line of exactly the cap and rejects one byte more", async () => {
    const cap = 1024;
    const body = (length: number): Buffer => {
      const prefix = '{"k":"';
      const suffix = '"}';
      return Buffer.from(
        prefix + "a".repeat(length - prefix.length - suffix.length) + suffix,
      );
    };
    const exact = await collect(
      bufferSource(Buffer.concat([body(cap), Buffer.from("\n")])),
      { startOffset: 0, generation: 1, maxLineBytes: cap, chunkBytes: 100 },
    );
    expect(exact.items[0]!.kind).toBe("record");
    const over = await collect(
      bufferSource(Buffer.concat([body(cap + 1), Buffer.from("\n")])),
      { startOffset: 0, generation: 1, maxLineBytes: cap, chunkBytes: 100 },
    );
    expect(over.items[0]).toMatchObject({
      kind: "placeholder",
      nextOffset: cap + 2,
      placeholder: {
        kind: "oversized_record",
        startOffset: 0,
        endOffset: cap + 1,
        byteLength: cap + 1,
        dedupeKey: oversizedDedupeKey(1, 0),
      },
    });
  });
});

describe("oversized lines", () => {
  const OVER = 5 * MIB;

  function fixture(): {
    source: CountingSource;
    before: string;
    after: string;
  } {
    const before = json({ n: "before" }) + "\n";
    const after = json({ n: "after" }) + "\n";
    const source = segmentSource([
      text(before),
      text('{"x":"'),
      fill(0x61, OVER - 8),
      text('"}'),
      text("\n"),
      text(after),
    ]);
    return { source, before, after };
  }

  it("turns a 5 MiB line into a bounded placeholder without decoding or parsing it", async () => {
    const { source, before, after } = fixture();
    const observed = observe();
    const stats = newReaderStats();
    const { items, end } = await collect(source, {
      startOffset: 0,
      generation: 3,
      deps: observed.deps,
      stats,
    });
    expect(items.map((item) => item.kind)).toEqual([
      "record",
      "placeholder",
      "record",
    ]);
    const placeholder = items[1]!;
    if (placeholder.kind !== "placeholder") throw new Error("unreachable");
    expect(placeholder.placeholder).toEqual({
      kind: "oversized_record",
      dedupeKey: oversizedDedupeKey(3, before.length),
      startOffset: before.length,
      endOffset: before.length + OVER,
      byteLength: OVER,
      reason: "record_too_large",
    });
    expect(placeholder.nextOffset).toBe(before.length + OVER + 1);
    expect(items[2]).toMatchObject({
      kind: "record",
      startOffset: before.length + OVER + 1,
      value: { n: "after" },
    });
    expect(end).toEqual({ nextOffset: source.total, partialBytes: 0 });
    expect(source.total).toBe(before.length + OVER + 1 + after.length);

    expect(observed.decodes).toEqual([before.length - 1, after.length - 1]);
    expect(observed.parses).toEqual([before.length - 1, after.length - 1]);
    expect(stats.oversizedLines).toBe(1);
    expect(stats.peakRetainedBytes).toBeLessThanOrEqual(MAX_LINE_BYTES);
    expect(source.largestRead).toBeLessThanOrEqual(64 * 1024);
    expect(source.bytesServed).toBe(source.total);
    assertNoLargeMaterialization(observed, stats, 1024);
  });

  it("makes the same observers fail for a reader that builds the whole line and discards it", async () => {
    const { source } = fixture();
    const observed = observe();
    await naiveScan(source, observed.deps);
    const stats = newReaderStats();
    expect(() => assertNoLargeMaterialization(observed, stats, 1024)).toThrow(
      /decoded \d+ bytes/,
    );
    expect(Math.max(...observed.decodes)).toBeGreaterThanOrEqual(OVER);
  });

  it("retains no more than the cap even when the line crosses the cap in the middle of a chunk", async () => {
    const cap = 100_000;
    const stats = newReaderStats();
    const source = segmentSource([
      text('{"a":1}\n'),
      text('{"x":"'),
      fill(0x62, 300_000),
      text('"}\n'),
      text('{"b":2}\n'),
    ]);
    const { items } = await collect(source, {
      startOffset: 0,
      generation: 1,
      maxLineBytes: cap,
      chunkBytes: 4096,
      stats,
    });
    expect(items.map((item) => item.kind)).toEqual([
      "record",
      "placeholder",
      "record",
    ]);
    expect(stats.peakRetainedBytes).toBeLessThanOrEqual(cap);
  });

  it("handles two consecutive oversized lines and a trailing oversized partial line", async () => {
    const cap = 1000;
    const source = segmentSource([
      fill(0x61, 3000),
      text("\n"),
      fill(0x62, 2000),
      text("\n"),
      text('{"ok":1}\n'),
      fill(0x63, 5000),
    ]);
    const stats = newReaderStats();
    const { items, end } = await collect(source, {
      startOffset: 0,
      generation: 2,
      maxLineBytes: cap,
      chunkBytes: 512,
      stats,
    });
    expect(items.map((item) => item.kind)).toEqual([
      "placeholder",
      "placeholder",
      "record",
    ]);
    expect(items[0]).toMatchObject({
      placeholder: { startOffset: 0, endOffset: 3000, byteLength: 3000 },
    });
    expect(items[1]).toMatchObject({
      placeholder: { startOffset: 3001, endOffset: 5001, byteLength: 2000 },
    });
    expect(end).toEqual({ nextOffset: 5002 + 9, partialBytes: 5000 });
    expect(stats.oversizedLines).toBe(2);
    expect(stats.peakRetainedBytes).toBeLessThanOrEqual(cap);
  });

  it("streams a 256 MiB line in bounded memory and yields to the scheduler", async () => {
    const huge = 256 * MIB;
    const source = segmentSource([
      fill(0x61, huge),
      text("\n"),
      text('{"after":true}\n'),
    ]);
    let clock = 0;
    let yielded = 0;
    const observed = observe();
    const stats = newReaderStats();
    const { items } = await collect(source, {
      startOffset: 0,
      generation: 1,
      stats,
      deps: {
        ...observed.deps,
        now: () => {
          clock += 2;
          return clock;
        },
        yieldToScheduler: async () => {
          yielded += 1;
        },
      },
    });
    expect(items.map((item) => item.kind)).toEqual(["placeholder", "record"]);
    expect(items[0]).toMatchObject({
      placeholder: { byteLength: huge, startOffset: 0, endOffset: huge },
    });
    expect(stats.peakRetainedBytes).toBeLessThanOrEqual(MAX_LINE_BYTES);
    expect(stats.yields).toBe(yielded);
    expect(yielded).toBeGreaterThan(1000);
    expect(source.largestRead).toBeLessThanOrEqual(64 * 1024);
    assertNoLargeMaterialization(observed, stats, 1024);
  }, 60_000);

  it("lets other timers run while a huge line is being scanned", async () => {
    const source = segmentSource([fill(0x61, 1024 * MIB), text("\n")]);
    const stats = newReaderStats();
    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
    }, 1);
    try {
      await collect(source, { startOffset: 0, generation: 1, stats });
    } finally {
      clearInterval(timer);
    }
    expect(stats.yields).toBeGreaterThan(0);
    expect(ticks).toBeGreaterThan(0);
  }, 60_000);
});

describe("huge files", () => {
  it("streams a file of many lines with bounded retention", async () => {
    const line = json({ type: "noise", pad: "x".repeat(80) }) + "\n";
    const count = 120_000;
    const source = segmentSource(
      Array.from({ length: count }, () => text(line)),
    );
    const stats = newReaderStats();
    const iterator = scanLines(source, {
      startOffset: 0,
      generation: 1,
      stats,
    });
    let seen = 0;
    let lastNext = 0;
    for (;;) {
      const step = await iterator.next();
      if (step.done) {
        expect(step.value).toEqual({
          nextOffset: count * line.length,
          partialBytes: 0,
        });
        break;
      }
      seen += 1;
      lastNext = step.value.nextOffset;
    }
    expect(seen).toBe(count);
    expect(lastNext).toBe(count * line.length);
    expect(stats.peakRetainedBytes).toBeLessThan(line.length * 2);
  }, 60_000);
});
