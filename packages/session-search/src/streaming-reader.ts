import {
  OVERSIZED_REASON,
  oversizedDedupeKey,
  type OversizedPlaceholder,
} from "./admission.js";

export const MAX_LINE_BYTES = 4 * 1024 * 1024;
export const DEFAULT_CHUNK_BYTES = 64 * 1024;
export const YIELD_AFTER_MS = 8;

export interface ChunkSource {
  read(position: number, into: Uint8Array): Promise<number>;
}

export interface LineDeps {
  decode(bytes: Uint8Array): string;
  parse(text: string): unknown;
  yieldToScheduler(): Promise<void>;
  now(): number;
}

export interface ReaderStats {
  chunks: number;
  bytesScanned: number;
  peakRetainedBytes: number;
  decodeCalls: number;
  decodedBytes: number;
  largestDecodedBytes: number;
  parseCalls: number;
  parsedChars: number;
  yields: number;
  oversizedLines: number;
}

export function newReaderStats(): ReaderStats {
  return {
    chunks: 0,
    bytesScanned: 0,
    peakRetainedBytes: 0,
    decodeCalls: 0,
    decodedBytes: 0,
    largestDecodedBytes: 0,
    parseCalls: 0,
    parsedChars: 0,
    yields: 0,
    oversizedLines: 0,
  };
}

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export function defaultLineDeps(): LineDeps {
  return {
    decode: (bytes) => utf8.decode(bytes),
    parse: (text) => JSON.parse(text) as unknown,
    yieldToScheduler: () => new Promise((resolve) => setImmediate(resolve)),
    now: () => performance.now(),
  };
}

export type SkipReason = "blank" | "invalid_utf8" | "invalid_json";

export type LineItem =
  | {
      kind: "record";
      startOffset: number;
      endOffset: number;
      nextOffset: number;
      value: unknown;
    }
  | {
      kind: "skipped";
      reason: SkipReason;
      startOffset: number;
      endOffset: number;
      nextOffset: number;
    }
  | {
      kind: "placeholder";
      placeholder: OversizedPlaceholder;
      nextOffset: number;
    };

export interface ScanEnd {
  nextOffset: number;
  partialBytes: number;
}

export interface ScanOptions {
  startOffset: number;
  generation: number;
  maxLineBytes?: number;
  chunkBytes?: number;
  deps?: Partial<LineDeps>;
  stats?: ReaderStats;
}

const NEWLINE = 0x0a;

function isBlank(bytes: Uint8Array): boolean {
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = bytes[index]!;
    if (byte !== 0x20 && byte !== 0x09 && byte !== 0x0d) return false;
  }
  return true;
}

export async function* scanLines(
  source: ChunkSource,
  options: ScanOptions,
): AsyncGenerator<LineItem, ScanEnd> {
  const maxLineBytes = options.maxLineBytes ?? MAX_LINE_BYTES;
  const chunkBytes = options.chunkBytes ?? DEFAULT_CHUNK_BYTES;
  const defaults = defaultLineDeps();
  const supplied = options.deps ?? {};
  const deps: LineDeps = {
    decode: supplied.decode ?? defaults.decode,
    parse: supplied.parse ?? defaults.parse,
    yieldToScheduler: supplied.yieldToScheduler ?? defaults.yieldToScheduler,
    now: supplied.now ?? defaults.now,
  };
  const stats = options.stats ?? newReaderStats();
  const buffer = Buffer.allocUnsafe(chunkBytes);

  let position = options.startOffset;
  let lineStart = options.startOffset;
  let retained: Buffer[] = [];
  let retainedBytes = 0;
  let skipping = false;
  let lastYield = deps.now();

  const finish = (line: Uint8Array, endOffset: number): LineItem => {
    const nextOffset = endOffset + 1;
    const startOffset = lineStart;
    if (isBlank(line)) {
      return {
        kind: "skipped",
        reason: "blank",
        startOffset,
        endOffset,
        nextOffset,
      };
    }
    stats.decodeCalls += 1;
    stats.decodedBytes += line.length;
    stats.largestDecodedBytes = Math.max(
      stats.largestDecodedBytes,
      line.length,
    );
    let text: string;
    try {
      text = deps.decode(line);
    } catch {
      return {
        kind: "skipped",
        reason: "invalid_utf8",
        startOffset,
        endOffset,
        nextOffset,
      };
    }
    stats.parseCalls += 1;
    stats.parsedChars += text.length;
    try {
      return {
        kind: "record",
        startOffset,
        endOffset,
        nextOffset,
        value: deps.parse(text),
      };
    } catch {
      return {
        kind: "skipped",
        reason: "invalid_json",
        startOffset,
        endOffset,
        nextOffset,
      };
    }
  };

  const finishOversized = (endOffset: number): LineItem => {
    stats.oversizedLines += 1;
    return {
      kind: "placeholder",
      nextOffset: endOffset + 1,
      placeholder: {
        kind: "oversized_record",
        dedupeKey: oversizedDedupeKey(options.generation, lineStart),
        startOffset: lineStart,
        endOffset,
        byteLength: endOffset - lineStart,
        reason: OVERSIZED_REASON,
      },
    };
  };

  for (;;) {
    const read = await source.read(position, buffer);
    if (read <= 0) break;
    stats.chunks += 1;
    stats.bytesScanned += read;
    const view = buffer.subarray(0, read);
    let at = 0;
    while (at < read) {
      const newline = view.indexOf(NEWLINE, at);
      const end = newline === -1 ? read : newline;
      const piece = view.subarray(at, end);
      if (!skipping && retainedBytes + piece.length > maxLineBytes) {
        skipping = true;
        retained = [];
        retainedBytes = 0;
      }
      if (!skipping && newline === -1) {
        if (piece.length > 0) {
          retained.push(Buffer.from(piece));
          retainedBytes += piece.length;
          stats.peakRetainedBytes = Math.max(
            stats.peakRetainedBytes,
            retainedBytes,
          );
        }
        at = read;
        continue;
      }
      if (newline === -1) {
        at = read;
        continue;
      }
      let item: LineItem;
      if (skipping) {
        item = finishOversized(position + end);
      } else if (retainedBytes === 0) {
        item = finish(piece, position + end);
      } else {
        retained.push(Buffer.from(piece));
        retainedBytes += piece.length;
        stats.peakRetainedBytes = Math.max(
          stats.peakRetainedBytes,
          retainedBytes,
        );
        item = finish(Buffer.concat(retained), position + end);
      }
      retained = [];
      retainedBytes = 0;
      skipping = false;
      lineStart = position + end + 1;
      at = end + 1;
      yield item;
    }
    position += read;
    if (deps.now() - lastYield >= YIELD_AFTER_MS) {
      stats.yields += 1;
      await deps.yieldToScheduler();
      lastYield = deps.now();
    }
  }
  return { nextOffset: lineStart, partialBytes: position - lineStart };
}
