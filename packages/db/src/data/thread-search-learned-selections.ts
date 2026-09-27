import { and, eq, gte, inArray, isNull, lt, lte, ne, sql } from "drizzle-orm";
import type { DbConnection, DbQueryConnection } from "../connection.js";
import { threadSearchLearnedSelections, threads } from "../schema.js";
import { likePrefixPattern } from "./sql-like.js";

/**
 * How strongly a past selection at this query still counts today: frequency
 * weighted by recency, halving every two weeks so an old one-off pick fades
 * out and a recently-reinforced habit stays on top.
 */
const LEARNED_SELECTION_HALF_LIFE_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Retention policy. Rows not reinforced within the window are pruned on the
 * next write (after ~6 half-lives their score is under 2% of its peak), and
 * the table is capped at a global row count, trimmed back to the floor by
 * oldest pick once exceeded. Rows for deleted threads are purged when the
 * thread is deleted.
 */
const LEARNED_SELECTION_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const LEARNED_SELECTION_MAX_ROWS = 2000;
const LEARNED_SELECTION_EVICT_FLOOR = 1800;

/**
 * A single pick is not a habit: a (query, thread) pair has to be selected at
 * least this many times before it can reorder search results.
 */
const LEARNED_SELECTION_MIN_COUNT = 2;

/** At most this many learned candidates are handed to the search ranker. */
const LEARNED_SELECTION_CANDIDATE_LIMIT = 20;

/** Longer queries than this are truncated before storing/matching. */
const LEARNED_SELECTION_QUERY_MAX_LENGTH = 60;

export function normalizeThreadSearchLearnedQuery(query: string): string {
  return query
    .trim()
    .toLowerCase()
    .slice(0, LEARNED_SELECTION_QUERY_MAX_LENGTH);
}

/**
 * Records that the user picked `threadId` after typing `query`. Repeated
 * selections for the same (query, thread) pair increment a counter rather
 * than creating new rows, so the table stays small and `score` below can
 * weigh frequency and recency together.
 *
 * The newest habit wins: picking a thread halves every other thread's count
 * for the exact same query, so a changed habit takes over within a few
 * picks instead of having to out-pick the old one. Pairs that reach zero are
 * dropped. A query that keeps alternating between threads never builds a
 * count of `LEARNED_SELECTION_MIN_COUNT` and so boosts nothing.
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
    const competingPicks = and(
      eq(threadSearchLearnedSelections.queryText, args.query),
      ne(threadSearchLearnedSelections.threadId, args.threadId),
    );
    tx.update(threadSearchLearnedSelections)
      .set({
        selectionCount: sql`${threadSearchLearnedSelections.selectionCount} / 2`,
      })
      .where(competingPicks)
      .run();
    tx.delete(threadSearchLearnedSelections)
      .where(
        and(
          competingPicks,
          lte(threadSearchLearnedSelections.selectionCount, 0),
        ),
      )
      .run();
    evictExcessLearnedSelections(tx, now);
  });
}

/** Forgets every learned pick of the given threads, e.g. on deletion. */
export function deleteThreadSearchLearnedSelections(
  db: DbQueryConnection,
  threadIds: readonly string[],
): void {
  if (threadIds.length === 0) return;
  db.delete(threadSearchLearnedSelections)
    .where(inArray(threadSearchLearnedSelections.threadId, [...threadIds]))
    .run();
}

function evictExcessLearnedSelections(db: DbQueryConnection, now: number): void {
  db.delete(threadSearchLearnedSelections)
    .where(
      lt(
        threadSearchLearnedSelections.lastSelectedAt,
        now - LEARNED_SELECTION_RETENTION_MS,
      ),
    )
    .run();
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

export interface LearnedThreadMatch {
  threadId: string;
  score: number;
}

/**
 * Lists the threads associated with a typed prefix, strongest first. Only
 * picks made at least `LEARNED_SELECTION_MIN_COUNT` times count, and deleted
 * or hidden threads are skipped so the next-best live thread can take the
 * boost, as are picks not reinforced within the retention window. The search ranker floats only the first of these that also matches
 * the query — the feature is "float the one thread I always pick here to the
 * top," not a re-ranked shortlist.
 */
export function listLearnedThreadMatches(
  db: DbQueryConnection,
  args: { queryPrefix: string; now: number },
): LearnedThreadMatch[] {
  const rows = db
    .select({
      threadId: threadSearchLearnedSelections.threadId,
      selectionCount: threadSearchLearnedSelections.selectionCount,
      lastSelectedAt: threadSearchLearnedSelections.lastSelectedAt,
    })
    .from(threadSearchLearnedSelections)
    .innerJoin(threads, eq(threads.id, threadSearchLearnedSelections.threadId))
    .where(
      and(
        sql`${threadSearchLearnedSelections.queryText} LIKE ${likePrefixPattern(args.queryPrefix)} ESCAPE '\\'`,
        sql`${threadSearchLearnedSelections.selectionCount} >= ${LEARNED_SELECTION_MIN_COUNT}`,
        // The write-time prune never runs on an install that stops picking,
        // so reads enforce the retention window too.
        gte(
          threadSearchLearnedSelections.lastSelectedAt,
          args.now - LEARNED_SELECTION_RETENTION_MS,
        ),
        isNull(threads.deletedAt),
        eq(threads.visibility, "visible"),
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

  return [...bestScoreByThread]
    .map(([threadId, score]) => ({ threadId, score }))
    .sort(
      (left, right) =>
        right.score - left.score || left.threadId.localeCompare(right.threadId),
    )
    .slice(0, LEARNED_SELECTION_CANDIDATE_LIMIT);
}
