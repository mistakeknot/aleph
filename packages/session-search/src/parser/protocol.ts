import type {
  InvalidationReason,
  PageBudget,
  SourcePage,
} from "../adapters/jsonl-page.js";
import type { SourceRef } from "../storage.js";

export type ParserProvider = "claude" | "codex";

export interface ParserSourceSpec {
  ref: SourceRef;
  provider: ParserProvider;
  path: string;
  sessionId?: string | null;
  agentId?: string | null;
}

export interface ParserReadRequest {
  t: "read";
  id: number;
  source: ParserSourceSpec;
  cursor: string | null;
  budget?: PageBudget;
}

export type ParserErrorCode = "unreadable" | "page_too_large" | "failed";

export type ParserResponse =
  | { t: "ready" }
  | { t: "page"; id: number; page: SourcePage }
  | { t: "error"; id: number; code: ParserErrorCode; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const INVALIDATION_REASONS: ReadonlySet<string> = new Set<InvalidationReason>([
  "missing",
  "not_regular_file",
  "replaced",
  "truncated",
  "rewritten",
  "unreadable_cursor",
]);

const PROGRESS_COUNTERS = [
  "startOffset",
  "nextOffset",
  "bytesConsumed",
  "lines",
  "recordCount",
  "placeholderCount",
  "waitingPartialBytes",
] as const;

const SKIPPED_COUNTERS = [
  "blank",
  "invalidUtf8",
  "invalidJson",
  "ignored",
] as const;

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validSourceRef(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.key === "string" &&
    value.key.length > 0 &&
    isCount(value.generation) &&
    typeof value.discoveredAtMs === "number" &&
    Number.isFinite(value.discoveredAtMs)
  );
}

function validBatch(value: unknown): boolean {
  if (!isRecord(value) || !validSourceRef(value.source)) return false;
  if (!Array.isArray(value.records)) return false;
  if (!value.records.every(isRecord)) return false;
  if (value.placeholders === undefined) return true;
  return (
    Array.isArray(value.placeholders) && value.placeholders.every(isRecord)
  );
}

function validCursor(value: unknown): boolean {
  return (
    isRecord(value) &&
    (value.expected === null || typeof value.expected === "string") &&
    typeof value.next === "string" &&
    value.next.length > 0
  );
}

function validSkipped(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (!SKIPPED_COUNTERS.every((name) => isCount(value[name]))) return false;
  return (
    Array.isArray(value.samples) &&
    value.samples.every(
      (sample) =>
        isRecord(sample) &&
        typeof sample.reason === "string" &&
        isCount(sample.startOffset) &&
        isCount(sample.endOffset),
    )
  );
}

function validProgress(value: unknown): boolean {
  return (
    isRecord(value) &&
    PROGRESS_COUNTERS.every((name) => isCount(value[name])) &&
    typeof value.endOfFile === "boolean"
  );
}

export function validateSourcePage(value: unknown): SourcePage | null {
  if (!isRecord(value)) return null;
  if (value.status === "invalidated") {
    return typeof value.reason === "string" &&
      INVALIDATION_REASONS.has(value.reason)
      ? (value as unknown as SourcePage)
      : null;
  }
  if (!validSkipped(value.skipped) || !validProgress(value.progress)) {
    return null;
  }
  if (value.status === "idle") {
    return value.batch === null && value.cursor === null
      ? (value as unknown as SourcePage)
      : null;
  }
  if (value.status === "page") {
    return validBatch(value.batch) && validCursor(value.cursor)
      ? (value as unknown as SourcePage)
      : null;
  }
  return null;
}

export function pageBindingViolation(
  page: SourcePage,
  ref: SourceRef,
  cursor: string | null,
): string | null {
  if (page.status !== "page") return null;
  const claimed = page.batch.source;
  if (
    claimed.key !== ref.key ||
    claimed.generation !== ref.generation ||
    claimed.discoveredAtMs !== ref.discoveredAtMs
  ) {
    return `page names source ${claimed.key}@${claimed.generation}, requested ${ref.key}@${ref.generation}`;
  }
  if (page.cursor.expected !== cursor) {
    return "page cursor does not continue from the requested cursor";
  }
  return null;
}

export function parseParserRequest(payload: Buffer): ParserReadRequest | null {
  let value: unknown;
  try {
    value = JSON.parse(payload.toString("utf8"));
  } catch {
    return null;
  }
  if (!isRecord(value) || value.t !== "read") return null;
  if (typeof value.id !== "number" || !isRecord(value.source)) return null;
  const source = value.source;
  if (source.provider !== "claude" && source.provider !== "codex") return null;
  if (typeof source.path !== "string" || !isRecord(source.ref)) return null;
  if (value.cursor !== null && typeof value.cursor !== "string") return null;
  return value as unknown as ParserReadRequest;
}

export function parseParserResponse(payload: Buffer): ParserResponse | null {
  let value: unknown;
  try {
    value = JSON.parse(payload.toString("utf8"));
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  if (value.t === "ready") return { t: "ready" };
  if (typeof value.id !== "number") return null;
  if (value.t === "page") {
    const page = validateSourcePage(value.page);
    return page === null ? null : { t: "page", id: value.id, page };
  }
  if (
    value.t === "error" &&
    (value.code === "unreadable" ||
      value.code === "page_too_large" ||
      value.code === "failed") &&
    typeof value.message === "string"
  ) {
    return value as unknown as ParserResponse;
  }
  return null;
}
