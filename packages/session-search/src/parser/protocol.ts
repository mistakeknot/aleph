import type { PageBudget, SourcePage } from "../adapters/jsonl-page.js";
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
  if (value.t === "page" && isRecord(value.page)) {
    return value as unknown as ParserResponse;
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
