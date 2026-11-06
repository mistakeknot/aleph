import { createHash } from "node:crypto";
import { open, type FileHandle } from "node:fs/promises";

import {
  DEFAULT_ADMISSION_LIMITS,
  measureValue,
  OVERSIZED_REASON,
  oversizedDedupeKey,
  type AdmissionLimits,
  type OversizedPlaceholder,
} from "../admission.js";
import { normalize, type NormalizedRecord } from "../contracts.js";
import type { CommitBatch, CursorUpdate, SourceRef } from "../storage.js";
import {
  MAX_LINE_BYTES,
  scanLines,
  type ChunkSource,
  type LineDeps,
  type LineItem,
  type ReaderStats,
  type SkipReason,
} from "../streaming-reader.js";

export const CURSOR_PREFIX = "claude1";
export const FINGERPRINT_BYTES = 256;
const PAGE_RESERVE_BYTES = 64 * 1024;
const SKIP_SAMPLE_LIMIT = 16;

export interface ClaudeSource {
  ref: SourceRef;
  path: string;
  sessionId?: string | null;
  agentId?: string | null;
}

export interface PageBudget {
  maxBytes: number;
  maxRecords: number;
  limits?: AdmissionLimits;
  maxLineBytes?: number;
}

export const DEFAULT_PAGE_BUDGET: PageBudget = {
  maxBytes: 2 * 1024 * 1024,
  maxRecords: 1000,
};

export interface ReadPageDeps extends Partial<LineDeps> {
  stats?: ReaderStats;
  chunkBytes?: number;
  wrapChunkSource?: (source: ChunkSource) => ChunkSource;
}

export type InvalidationReason =
  | "missing"
  | "not_regular_file"
  | "replaced"
  | "truncated"
  | "rewritten"
  | "unreadable_cursor";

export interface SkippedLine {
  reason: SkipReason | "ignored";
  startOffset: number;
  endOffset: number;
}

export interface SkippedSummary {
  blank: number;
  invalidUtf8: number;
  invalidJson: number;
  ignored: number;
  samples: SkippedLine[];
}

export interface PageProgress {
  startOffset: number;
  nextOffset: number;
  bytesConsumed: number;
  lines: number;
  recordCount: number;
  placeholderCount: number;
  waitingPartialBytes: number;
  endOfFile: boolean;
}

export type SourcePage =
  | {
      status: "page";
      batch: CommitBatch;
      cursor: CursorUpdate;
      skipped: SkippedSummary;
      progress: PageProgress;
    }
  | {
      status: "idle";
      batch: null;
      cursor: null;
      skipped: SkippedSummary;
      progress: PageProgress;
    }
  | { status: "invalidated"; reason: InvalidationReason };

interface ParsedCursor {
  dev: string;
  ino: string;
  offset: number;
  prefixLength: number;
  prefixHash: string;
  tailLength: number;
  tailHash: string;
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 32);
}

export function encodeCursor(cursor: ParsedCursor): string {
  return [
    CURSOR_PREFIX,
    cursor.dev,
    cursor.ino,
    cursor.offset,
    cursor.prefixLength,
    cursor.prefixHash,
    cursor.tailLength,
    cursor.tailHash,
  ].join(":");
}

export function decodeCursor(value: string): ParsedCursor | null {
  const parts = value.split(":");
  if (parts.length !== 8 || parts[0] !== CURSOR_PREFIX) return null;
  const offset = Number(parts[3]);
  const prefixLength = Number(parts[4]);
  const tailLength = Number(parts[6]);
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(prefixLength) ||
    prefixLength < 0 ||
    prefixLength > FINGERPRINT_BYTES ||
    !Number.isSafeInteger(tailLength) ||
    tailLength < 0 ||
    tailLength > FINGERPRINT_BYTES
  ) {
    return null;
  }
  return {
    dev: parts[1]!,
    ino: parts[2]!,
    offset,
    prefixLength,
    prefixHash: parts[5]!,
    tailLength,
    tailHash: parts[7]!,
  };
}

export function cursorOffset(cursor: string | null): number | null {
  if (cursor === null) return 0;
  const parsed = decodeCursor(cursor);
  return parsed === null ? null : parsed.offset;
}

async function readExactly(
  handle: FileHandle,
  position: number,
  length: number,
): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  let filled = 0;
  while (filled < length) {
    const { bytesRead } = await handle.read(
      buffer,
      filled,
      length - filled,
      position + filled,
    );
    if (bytesRead === 0) break;
    filled += bytesRead;
  }
  return buffer.subarray(0, filled);
}

async function fingerprint(
  handle: FileHandle,
  offset: number,
): Promise<{
  prefixLength: number;
  prefixHash: string;
  tailLength: number;
  tailHash: string;
}> {
  const prefix = await readExactly(
    handle,
    0,
    Math.min(FINGERPRINT_BYTES, offset),
  );
  const tailLength = Math.min(FINGERPRINT_BYTES, offset);
  const tail = await readExactly(handle, offset - tailLength, tailLength);
  return {
    prefixLength: prefix.length,
    prefixHash: digest(prefix),
    tailLength: tail.length,
    tailHash: digest(tail),
  };
}

function chunkSourceOf(handle: FileHandle): ChunkSource {
  return {
    async read(position, into) {
      const { bytesRead } = await handle.read(
        into,
        0,
        into.byteLength,
        position,
      );
      return bytesRead;
    },
  };
}

function emptySkipped(): SkippedSummary {
  return { blank: 0, invalidUtf8: 0, invalidJson: 0, ignored: 0, samples: [] };
}

function noteSkip(summary: SkippedSummary, line: SkippedLine): void {
  if (line.reason === "blank") summary.blank += 1;
  else if (line.reason === "invalid_utf8") summary.invalidUtf8 += 1;
  else if (line.reason === "invalid_json") summary.invalidJson += 1;
  else summary.ignored += 1;
  if (line.reason !== "blank" && summary.samples.length < SKIP_SAMPLE_LIMIT) {
    summary.samples.push(line);
  }
}

function placeholderFor(
  generation: number,
  startOffset: number,
  endOffset: number,
): OversizedPlaceholder {
  return {
    kind: "oversized_record",
    dedupeKey: oversizedDedupeKey(generation, startOffset),
    startOffset,
    endOffset,
    byteLength: endOffset - startOffset,
    reason: OVERSIZED_REASON,
  };
}

async function openChecked(
  path: string,
): Promise<
  | { ok: true; handle: FileHandle; dev: string; ino: string; size: number }
  | { ok: false; reason: InvalidationReason }
> {
  let handle: FileHandle;
  try {
    handle = await open(path, "r");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return { ok: false, reason: "missing" };
    }
    throw error;
  }
  const stat = await handle.stat({ bigint: true });
  if (!stat.isFile()) {
    await handle.close();
    return { ok: false, reason: "not_regular_file" };
  }
  return {
    ok: true,
    handle,
    dev: stat.dev.toString(),
    ino: stat.ino.toString(),
    size: Number(stat.size),
  };
}

export async function readPage(
  source: ClaudeSource,
  cursor: string | null,
  budget: PageBudget = DEFAULT_PAGE_BUDGET,
  deps: ReadPageDeps = {},
): Promise<SourcePage> {
  const opened = await openChecked(source.path);
  if (!opened.ok) return { status: "invalidated", reason: opened.reason };
  const { handle } = opened;
  try {
    let startOffset = 0;
    if (cursor !== null) {
      const parsed = decodeCursor(cursor);
      if (parsed === null) {
        return { status: "invalidated", reason: "unreadable_cursor" };
      }
      if (parsed.dev !== opened.dev || parsed.ino !== opened.ino) {
        return { status: "invalidated", reason: "replaced" };
      }
      if (opened.size < parsed.offset) {
        return { status: "invalidated", reason: "truncated" };
      }
      const current = await fingerprint(handle, parsed.offset);
      if (
        current.prefixLength !== parsed.prefixLength ||
        current.prefixHash !== parsed.prefixHash ||
        current.tailLength !== parsed.tailLength ||
        current.tailHash !== parsed.tailHash
      ) {
        return { status: "invalidated", reason: "rewritten" };
      }
      startOffset = parsed.offset;
    }
    return await assemblePage(
      source,
      cursor,
      startOffset,
      opened,
      budget,
      deps,
    );
  } finally {
    await handle.close();
  }
}

async function assemblePage(
  source: ClaudeSource,
  expected: string | null,
  startOffset: number,
  opened: { handle: FileHandle; dev: string; ino: string },
  budget: PageBudget,
  deps: ReadPageDeps,
): Promise<SourcePage> {
  const baseLimits = budget.limits ?? DEFAULT_ADMISSION_LIMITS;
  const limits: AdmissionLimits = {
    ...baseLimits,
    maxBatchInputBytes: Math.max(
      0,
      baseLimits.maxBatchInputBytes - PAGE_RESERVE_BYTES,
    ),
    maxBatchAccountedBytes: Math.max(
      0,
      baseLimits.maxBatchAccountedBytes - PAGE_RESERVE_BYTES,
    ),
  };
  const generation = source.ref.generation;
  const { handle } = opened;
  let raw: ChunkSource = chunkSourceOf(handle);
  if (deps.wrapChunkSource) raw = deps.wrapChunkSource(raw);

  const iterator = scanLines(raw, {
    startOffset,
    generation,
    maxLineBytes: budget.maxLineBytes ?? MAX_LINE_BYTES,
    chunkBytes: deps.chunkBytes,
    deps: {
      decode: deps.decode,
      parse: deps.parse,
      yieldToScheduler: deps.yieldToScheduler,
      now: deps.now,
    },
    stats: deps.stats,
  });

  const records: NormalizedRecord[] = [];
  const placeholders: OversizedPlaceholder[] = [];
  const skipped = emptySkipped();
  let inputBytes = 0;
  let accountedBytes = 0;
  let nextOffset = startOffset;
  let lines = 0;
  let endOfFile = false;
  let partial = 0;

  const countRoom = (): number =>
    budget.maxRecords - records.length - placeholders.length;

  for (;;) {
    const step = await iterator.next();
    if (step.done) {
      endOfFile = true;
      partial = step.value.partialBytes;
      break;
    }
    const item: LineItem = step.value;
    let admitted: NormalizedRecord[] = [];
    let placeholder: OversizedPlaceholder | null = null;
    let cost = { input: 0, accounted: 0 };

    if (item.kind === "skipped") {
      noteSkip(skipped, {
        reason: item.reason,
        startOffset: item.startOffset,
        endOffset: item.endOffset,
      });
    } else if (item.kind === "placeholder") {
      placeholder = item.placeholder;
    } else {
      const normalized = normalize(item.value, {
        provider: "claude",
        sessionId: source.sessionId ?? null,
        agentId: source.agentId ?? null,
        position: item.startOffset,
      });
      if (normalized.length === 0) {
        noteSkip(skipped, {
          reason: "ignored",
          startOffset: item.startOffset,
          endOffset: item.endOffset,
        });
      } else {
        const measured = measureValue(normalized, limits);
        if (!measured.ok || normalized.length > budget.maxRecords) {
          placeholder = placeholderFor(
            generation,
            item.startOffset,
            item.endOffset,
          );
        } else {
          admitted = normalized;
        }
      }
    }

    if (placeholder !== null) {
      const measured = measureValue(placeholder, limits);
      cost = measured.ok
        ? { input: measured.inputBytes, accounted: measured.accountedBytes }
        : { input: 0, accounted: 0 };
    } else if (admitted.length > 0) {
      const measured = measureValue(admitted, limits);
      cost = measured.ok
        ? { input: measured.inputBytes, accounted: measured.accountedBytes }
        : { input: 0, accounted: 0 };
    }

    const added = admitted.length + (placeholder === null ? 0 : 1);
    const fits =
      added <= countRoom() &&
      inputBytes + cost.input <= limits.maxBatchInputBytes &&
      accountedBytes + cost.accounted <= limits.maxBatchAccountedBytes;
    if (!fits && lines > 0 && added > 0) {
      await iterator.return({ nextOffset, partialBytes: 0 });
      break;
    }

    lines += 1;
    records.push(...admitted);
    if (placeholder !== null) placeholders.push(placeholder);
    inputBytes += cost.input;
    accountedBytes += cost.accounted;
    nextOffset = item.nextOffset;
    if (nextOffset - startOffset >= budget.maxBytes) {
      await iterator.return({ nextOffset, partialBytes: 0 });
      break;
    }
  }

  const progress: PageProgress = {
    startOffset,
    nextOffset,
    bytesConsumed: nextOffset - startOffset,
    lines,
    recordCount: records.length,
    placeholderCount: placeholders.length,
    waitingPartialBytes: partial,
    endOfFile,
  };
  if (nextOffset === startOffset) {
    return { status: "idle", batch: null, cursor: null, skipped, progress };
  }
  const print = await fingerprint(handle, nextOffset);
  const next = encodeCursor({
    dev: opened.dev,
    ino: opened.ino,
    offset: nextOffset,
    ...print,
  });
  return {
    status: "page",
    batch: { source: source.ref, records, placeholders },
    cursor: { expected, next },
    skipped,
    progress,
  };
}
