import type Database from "better-sqlite3";

const STRUCTURE_ROW_ID = 10;
const COOKIE_BYTES = 4;
const MAX_LEVELS = 64;
const MAX_SEGMENTS = 1_000_000;

export interface FtsLevel {
  mergeInProgress: number;
  segments: number;
}

export interface FtsStructure {
  totalSegments: number;
  levels: FtsLevel[];
}

export interface MergeThresholds {
  automerge: number;
  crisismerge: number;
}

export const EMPTY_FTS_STRUCTURE: FtsStructure = {
  totalSegments: 0,
  levels: [],
};

function readVarint(
  buffer: Uint8Array,
  position: number,
): { value: number; next: number } {
  let value = 0n;
  for (let index = 0; index < 9; index += 1) {
    const at = position + index;
    if (at >= buffer.length) throw new Error("truncated FTS structure record");
    const byte = buffer[at] as number;
    if (index === 8) {
      value = (value << 8n) | BigInt(byte);
      return { value: Number(value), next: at + 1 };
    }
    value = (value << 7n) | BigInt(byte & 0x7f);
    if ((byte & 0x80) === 0) return { value: Number(value), next: at + 1 };
  }
  throw new Error("unreachable varint state");
}

export function parseFtsStructure(buffer: Uint8Array): FtsStructure {
  if (buffer.length < COOKIE_BYTES) {
    throw new Error("FTS structure record is shorter than its cookie");
  }
  let position = COOKIE_BYTES;
  const levelCount = readVarint(buffer, position);
  position = levelCount.next;
  const segmentCount = readVarint(buffer, position);
  position = segmentCount.next;
  const writeCounter = readVarint(buffer, position);
  position = writeCounter.next;
  if (levelCount.value > MAX_LEVELS || segmentCount.value > MAX_SEGMENTS) {
    throw new Error("FTS structure record exceeds sane bounds");
  }
  const levels: FtsLevel[] = [];
  for (let level = 0; level < levelCount.value; level += 1) {
    const merging = readVarint(buffer, position);
    position = merging.next;
    const segments = readVarint(buffer, position);
    position = segments.next;
    if (segments.value > MAX_SEGMENTS) {
      throw new Error("FTS structure level exceeds sane bounds");
    }
    for (let segment = 0; segment < segments.value; segment += 1) {
      for (let field = 0; field < 3; field += 1) {
        position = readVarint(buffer, position).next;
      }
    }
    levels.push({ mergeInProgress: merging.value, segments: segments.value });
  }
  return { totalSegments: segmentCount.value, levels };
}

export function readFtsStructure(
  db: Database.Database,
  table = "content_fts",
): FtsStructure {
  const row = db
    .prepare(`SELECT block FROM ${table}_data WHERE id = ?`)
    .get(STRUCTURE_ROW_ID) as { block: Buffer } | undefined;
  if (row === undefined) return EMPTY_FTS_STRUCTURE;
  return parseFtsStructure(row.block);
}

export const FTS_HASH_BYTES = 1024 * 1024;
const FTS_PENDING_EXPANSION = 4;

export interface FlushItem {
  replaces: boolean;
  textBytes: number;
}

export function estimateBatchFlushes(items: readonly FlushItem[]): number {
  let flushes = 0;
  let pendingBytes = 0;
  for (const item of items) {
    flushes += item.replaces ? 2 : 1;
    pendingBytes += item.textBytes;
  }
  return (
    Math.max(1, flushes) +
    Math.floor((pendingBytes * FTS_PENDING_EXPANSION) / FTS_HASH_BYTES)
  );
}

export function mergeMayRun(
  structure: FtsStructure,
  thresholds: MergeThresholds,
  flushesInBatch = 1,
): boolean {
  const reach = Math.max(1, thresholds.automerge) - Math.max(1, flushesInBatch);
  if (reach <= 0) return true;
  for (const level of structure.levels) {
    if (level.mergeInProgress > 0) return true;
    if (
      level.segments > 0 &&
      level.segments >= Math.min(reach, thresholds.crisismerge - 1)
    ) {
      return true;
    }
  }
  return false;
}
