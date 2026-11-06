import {
  cursorCodec,
  readJsonlPage,
  type JsonlSource,
  type PageAdapter,
  type PageBudget,
  type ParsedCursor,
  type ReadPageDeps,
  type SourcePage,
} from "./jsonl-page.js";

export {
  DEFAULT_PAGE_BUDGET,
  FINGERPRINT_BYTES,
  type InvalidationReason,
  type PageBudget,
  type PageProgress,
  type ReadPageDeps,
  type SkippedLine,
  type SkippedSummary,
  type SourcePage,
} from "./jsonl-page.js";

export const CURSOR_PREFIX = "claude1";

export type ClaudeSource = JsonlSource;

const codec = cursorCodec(CURSOR_PREFIX);

export function encodeCursor(cursor: ParsedCursor): string {
  return codec.encode(cursor);
}

export function decodeCursor(value: string): ParsedCursor | null {
  return codec.decode(value);
}

export function cursorOffset(cursor: string | null): number | null {
  return codec.offset(cursor);
}

const claudeAdapter: PageAdapter = {
  provider: "claude",
  cursorPrefix: CURSOR_PREFIX,
  async resolveIdentity(source) {
    return {
      sessionId: source.sessionId ?? null,
      agentId: source.agentId ?? null,
    };
  },
};

export function readPage(
  source: ClaudeSource,
  cursor: string | null,
  budget?: PageBudget,
  deps?: ReadPageDeps,
): Promise<SourcePage> {
  return readJsonlPage(claudeAdapter, source, cursor, budget, deps);
}
