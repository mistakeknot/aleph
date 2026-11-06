import { basename } from "node:path";

import { scanLines } from "../streaming-reader.js";
import {
  chunkSourceOf,
  cursorCodec,
  readJsonlPage,
  type JsonlSource,
  type PageAdapter,
  type PageBudget,
  type ParsedCursor,
  type ReadPageDeps,
  type SourcePage,
} from "./jsonl-page.js";

export const CODEX_CURSOR_PREFIX = "codex1";

const IDENTITY_SCAN_LINES = 8;
const IDENTITY_MAX_LINE_BYTES = 256 * 1024;
const ROLLOUT_SESSION_ID =
  /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

export type CodexSource = Omit<JsonlSource, "agentId">;

const codec = cursorCodec(CODEX_CURSOR_PREFIX);

export function encodeCodexCursor(cursor: ParsedCursor): string {
  return codec.encode(cursor);
}

export function decodeCodexCursor(value: string): ParsedCursor | null {
  return codec.decode(value);
}

export function codexCursorOffset(cursor: string | null): number | null {
  return codec.offset(cursor);
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function sessionIdFromRolloutPath(path: string): string | null {
  const match = ROLLOUT_SESSION_ID.exec(basename(path));
  return match === null ? null : match[1]!.toLowerCase();
}

function sessionIdFromMeta(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as { type?: unknown; payload?: unknown };
  if (record.type !== "session_meta") return null;
  if (typeof record.payload !== "object" || record.payload === null) {
    return null;
  }
  const payload = record.payload as { session_id?: unknown; id?: unknown };
  return nonEmpty(payload.session_id) ?? nonEmpty(payload.id);
}

const codexAdapter: PageAdapter = {
  provider: "codex",
  cursorPrefix: CODEX_CURSOR_PREFIX,
  async resolveIdentity(source, handle) {
    const supplied = nonEmpty(source.sessionId);
    if (supplied !== null) return { sessionId: supplied, agentId: null };
    const iterator = scanLines(chunkSourceOf(handle), {
      startOffset: 0,
      generation: source.ref.generation,
      maxLineBytes: IDENTITY_MAX_LINE_BYTES,
    });
    let seen = 0;
    let found: string | null = null;
    for (;;) {
      const step = await iterator.next();
      if (step.done) break;
      if (step.value.kind === "record") {
        found = sessionIdFromMeta(step.value.value);
        if (found !== null) break;
      }
      seen += 1;
      if (seen >= IDENTITY_SCAN_LINES) break;
    }
    await iterator.return({ nextOffset: 0, partialBytes: 0 });
    return {
      sessionId: found ?? sessionIdFromRolloutPath(source.path),
      agentId: null,
    };
  },
};

export function readCodexPage(
  source: CodexSource,
  cursor: string | null,
  budget?: PageBudget,
  deps?: ReadPageDeps,
): Promise<SourcePage> {
  return readJsonlPage(codexAdapter, source, cursor, budget, deps);
}
