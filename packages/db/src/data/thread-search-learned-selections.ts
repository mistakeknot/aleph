import { like, sql } from "drizzle-orm";
import type { DbConnection, DbQueryConnection } from "../connection.js";
import { threadSearchLearnedSelections } from "../schema.js";

/**
 * How strongly a past selection at this query still counts today: frequency
 * weighted by recency, halving every two weeks so an old one-off pick fades
 * out and a recently-reinforced habit stays on top.
 */
const LEARNED_SELECTION_HALF_LIFE_MS = 14 * 24 * 60 * 60 * 1000;

/** Global row cap for the table; trimmed back to this floor once exceeded. */
const LEARNED_SELECTION_MAX_ROWS = 2000;
const LEARNED_SELECTION_EVICT_FLOOR = 1800;

/** Longer queries than this are truncated before storing/matching. */
const LEARNED_SELECTION_QUERY_MAX_LENGTH = 60;

export function normalizeThreadSearchLearnedQuery(query: string): string {
  return query
    .trim()
    .toLowerCase()
    .slice(0, LEARNED_SELECTION_QUERY_MAX_LENGTH);
}

function escapeLikePattern(value: string): string {
  return value.replace(/[%_\\]/g, (char) => `\\${char}`);
}

/**
 * Records that the user picked `threadId` after typing `query`. Repeated
 * selections for the same (query, thread) pair increment a counter rather
 * than creating new rows, so the table stays small and `score` below can
 * weigh frequency and recency together.
 */
export function recordThreadSearchSelection(
  db: DbConnection,
  args: { query: string; threadId: string },
): void {
  const now = Date.now();
  db.transaction((tx) => {
    tx.insert(threadSearchLearnedSelections)
      .values({
        queryText: args.query,
        threadId: args.threadId,
        selectionCount: 1,
        lastSelectedAt: now,
        createdAt: now,
      })
      .onConflictDoUpdate({
        target: [
          threadSearchLearnedSelections.queryText,
          threadSearchLearnedSelections.threadId,
        ],
        set: {
          selectionCount: sql`${threadSearchLearnedSelections.selectionCount} + 1`,
          lastSelectedAt: now,
        },
      })
      .run();
    evictExcessLearnedSelections(tx);
  });
}

function evictExcessLearnedSelections(db: DbQueryConnection): void {
  const total = db
    .select({ total: sql<number>`COUNT(*)` })
    .from(threadSearchLearnedSelections)
    .get()?.total;
  if (total === undefined || total <= LEARNED_SELECTION_MAX_ROWS) return;
  const excess = total - LEARNED_SELECTION_EVICT_FLOOR;
  db.run(sql`
    DELETE FROM ${threadSearchLearnedSelections}
    WHERE rowid IN (
      SELECT rowid FROM ${threadSearchLearnedSelections}
      ORDER BY ${threadSearchLearnedSelections.lastSelectedAt} ASC
      LIMIT ${excess}
    )
  `);
}

export interface TopLearnedThreadMatch {
  threadId: string;
  score: number;
}

/**
 * Finds the thread most strongly associated with a typed prefix, if any.
 * Only the single top thread is returned — the feature is "float the one
 * thread I always pick here to the top," not a re-ranked shortlist.
 */
export function findTopLearnedThreadMatch(
  db: DbQueryConnection,
  args: { queryPrefix: string; now: number },
): TopLearnedThreadMatch | null {
  const rows = db
    .select({
      threadId: threadSearchLearnedSelections.threadId,
      selectionCount: threadSearchLearnedSelections.selectionCount,
      lastSelectedAt: threadSearchLearnedSelections.lastSelectedAt,
    })
    .from(threadSearchLearnedSelections)
    .where(
      like(
        threadSearchLearnedSelections.queryText,
        `${escapeLikePattern(args.queryPrefix)}%`,
      ),
    )
    .all();

  // A thread can have several stored queries (e.g. "af" and "afternoon
  // standup") that both match the typed prefix; take each thread's best
  // score rather than summing, so re-typing variants of the same query
  // doesn't double-count.
  const bestScoreByThread = new Map<string, number>();
  for (const row of rows) {
    const ageMs = Math.max(0, args.now - row.lastSelectedAt);
    const decay = Math.pow(0.5, ageMs / LEARNED_SELECTION_HALF_LIFE_MS);
    const score = row.selectionCount * decay;
    const previousBest = bestScoreByThread.get(row.threadId) ?? 0;
    if (score > previousBest) {
      bestScoreByThread.set(row.threadId, score);
    }
  }

  let best: TopLearnedThreadMatch | null = null;
  for (const [threadId, score] of bestScoreByThread) {
    if (best === null || score > best.score) {
      best = { threadId, score };
    }
  }
  return best;
}
