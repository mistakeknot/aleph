import type { MemoryPressureState } from "../memory-pressure.js";
import {
  validBatch,
  validCursor,
  validSourceRef,
} from "../parser/protocol.js";
import type {
  CommitBatch,
  CommitResult,
  CursorUpdate,
  FenceEntry,
  RefusalCode,
  SourceRef,
} from "../storage.js";

export type WriterRequest =
  | { t: "sync"; id: number; fences: FenceEntry[] }
  | { t: "fence"; id: number; entry: FenceEntry }
  | { t: "unfence"; id: number; key: string }
  | {
      t: "commit";
      id: number;
      batch: CommitBatch;
      cursor: CursorUpdate;
      token: string | null;
    }
  | { t: "cursor"; id: number; source: SourceRef }
  | { t: "remove"; id: number; key: string; chunkRows?: number }
  | { t: "pressure"; id: number; source: SourceRef; mergePossible: boolean }
  | { t: "retry"; id: number; mitigation: string }
  | { t: "state"; id: number };

export type WriterRequestBody = WriterRequest extends infer R
  ? R extends { id: number }
    ? Omit<R, "id">
    : never
  : never;

export interface WriterStoreState {
  pressure: MemoryPressureState;
  epoch: number;
  suspended: { code: string; message: string } | null;
}

export type WriterResponse =
  | { t: "ready" }
  | { t: "done"; id: number }
  | { t: "commit"; id: number; result: CommitResult }
  | { t: "cursor"; id: number; cursor: string | null }
  | { t: "removed"; id: number; rows: number }
  | { t: "pressure"; id: number; state: MemoryPressureState }
  | { t: "retry"; id: number; ok: boolean; reason: string | null }
  | { t: "state"; id: number; state: WriterStoreState }
  | { t: "error"; id: number; message: string };

const REFUSAL_CODES: ReadonlySet<string> = new Set<RefusalCode>([
  "suspended",
  "invalid_batch",
  "batch_too_large",
  "db_capacity",
  "total_budget",
  "wal_reserve",
  "cursor_conflict",
  "stale_generation",
  "disk_full",
  "db_page_limit",
  "memory_budget",
  "memory_pressure",
  "out_of_memory",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function parseJson(payload: Buffer): unknown {
  try {
    return JSON.parse(payload.toString("utf8"));
  } catch {
    return null;
  }
}

function validFence(value: unknown): value is FenceEntry {
  return (
    isRecord(value) &&
    typeof value.key === "string" &&
    value.key.length > 0 &&
    isCount(value.generation) &&
    typeof value.token === "string" &&
    value.token.length > 0
  );
}

export function parseWriterRequest(payload: Buffer): WriterRequest | null {
  const value = parseJson(payload);
  if (!isRecord(value) || !isCount(value.id)) return null;
  switch (value.t) {
    case "sync":
      return Array.isArray(value.fences) && value.fences.every(validFence)
        ? (value as unknown as WriterRequest)
        : null;
    case "fence":
      return validFence(value.entry) ? (value as unknown as WriterRequest) : null;
    case "unfence":
      return typeof value.key === "string" && value.key.length > 0
        ? (value as unknown as WriterRequest)
        : null;
    case "commit":
      return validBatch(value.batch) &&
        validCursor(value.cursor) &&
        (value.token === null || typeof value.token === "string")
        ? (value as unknown as WriterRequest)
        : null;
    case "cursor":
      return validSourceRef(value.source)
        ? (value as unknown as WriterRequest)
        : null;
    case "remove":
      return typeof value.key === "string" &&
        value.key.length > 0 &&
        (value.chunkRows === undefined ||
          (isCount(value.chunkRows) && value.chunkRows > 0))
        ? (value as unknown as WriterRequest)
        : null;
    case "pressure":
      return validSourceRef(value.source) &&
        typeof value.mergePossible === "boolean"
        ? (value as unknown as WriterRequest)
        : null;
    case "retry":
      return typeof value.mitigation === "string"
        ? (value as unknown as WriterRequest)
        : null;
    case "state":
      return value as unknown as WriterRequest;
    default:
      return null;
  }
}

const RESULT_COUNTERS = [
  "epoch",
  "inserted",
  "replayed",
  "updated",
  "corrected",
  "quarantined",
  "unindexed",
  "estimatedDirtyPages",
] as const;

function validCommitResult(value: unknown): value is CommitResult {
  if (!isRecord(value)) return false;
  if (typeof value.committed !== "boolean") return false;
  if (typeof value.mergePossible !== "boolean") return false;
  if (value.cursor !== null && typeof value.cursor !== "string") return false;
  if (!RESULT_COUNTERS.every((name) => isCount(value[name]))) return false;
  if (!Array.isArray(value.entries)) return false;
  if (value.refusal === null) return value.committed;
  return (
    !value.committed &&
    isRecord(value.refusal) &&
    typeof value.refusal.code === "string" &&
    REFUSAL_CODES.has(value.refusal.code) &&
    typeof value.refusal.message === "string"
  );
}

function validPressure(value: unknown): value is MemoryPressureState {
  return (
    isRecord(value) &&
    (value.status === "clear" ||
      value.status === "suspended" ||
      value.status === "retry_armed") &&
    isCount(value.consecutiveFailures) &&
    isCount(value.totalFailures) &&
    isCount(value.clears) &&
    isCount(value.retriesUsed) &&
    Array.isArray(value.recent)
  );
}

export function parseWriterResponse(payload: Buffer): WriterResponse | null {
  const value = parseJson(payload);
  if (!isRecord(value)) return null;
  if (value.t === "ready") return { t: "ready" };
  if (!isCount(value.id)) return null;
  switch (value.t) {
    case "done":
      return { t: "done", id: value.id };
    case "commit":
      return validCommitResult(value.result)
        ? { t: "commit", id: value.id, result: value.result }
        : null;
    case "cursor":
      return value.cursor === null || typeof value.cursor === "string"
        ? { t: "cursor", id: value.id, cursor: value.cursor }
        : null;
    case "removed":
      return isCount(value.rows)
        ? { t: "removed", id: value.id, rows: value.rows }
        : null;
    case "pressure":
      return validPressure(value.state)
        ? { t: "pressure", id: value.id, state: value.state }
        : null;
    case "retry":
      return typeof value.ok === "boolean" &&
        (value.reason === null || typeof value.reason === "string")
        ? { t: "retry", id: value.id, ok: value.ok, reason: value.reason }
        : null;
    case "state": {
      const state = value.state;
      return isRecord(state) &&
        validPressure(state.pressure) &&
        isCount(state.epoch) &&
        (state.suspended === null ||
          (isRecord(state.suspended) &&
            typeof state.suspended.code === "string" &&
            typeof state.suspended.message === "string"))
        ? {
            t: "state",
            id: value.id,
            state: state as unknown as WriterStoreState,
          }
        : null;
    }
    case "error":
      return typeof value.message === "string"
        ? { t: "error", id: value.id, message: value.message }
        : null;
    default:
      return null;
  }
}
