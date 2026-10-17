import { PERSONAL_PROJECT_ID, type ThreadListEntry } from "@bb/domain";
import type {
  ThreadSearchMatch,
  ThreadSearchResponse,
} from "@bb/server-contract";
import { formatRelativeTime } from "@/lib/relative-time";
import { getThreadDisplayTitle } from "@/lib/thread-title";
import {
  normalizeThreadLifecycleFilter,
  type ThreadArchiveFilter,
} from "@/lib/thread-lifecycle-filter";

export interface PaletteThreadSearchRow {
  id: string;
  lifecycle: ThreadArchiveFilter;
  primaryText: string;
  highlightRanges: readonly ThreadSearchMatch["highlightRanges"][number][];
  secondaryTitle: string | null;
  projectName: string | null;
  relativeTime: string;
  projectId: string;
  threadId: string;
  thread: ThreadListEntry;
}

interface BuildPaletteThreadSearchRowsArgs {
  lifecycles: readonly ThreadArchiveFilter[];
  now: number;
  projectNamesById: ReadonlyMap<string, string>;
  query: string;
  recentThreads: readonly ThreadListEntry[];
  searchResponse: ThreadSearchResponse | undefined;
  searchResultsAreCurrent: boolean;
}

export interface PaletteThreadSearchRowsResult {
  isRecent: boolean;
  rows: PaletteThreadSearchRow[];
}

const RECENT_THREAD_LIMIT = 20;

function stablePartitionByPinned<T>(
  items: readonly T[],
  isPinned: (item: T) => boolean,
): T[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const delta = Number(isPinned(b.item)) - Number(isPinned(a.item));
      return delta !== 0 ? delta : a.index - b.index;
    })
    .map(({ item }) => item);
}

function isTitleMatch(match: ThreadSearchMatch): boolean {
  return match.sourceKind === "title" || match.sourceKind === "title_fallback";
}

function projectMetadata(
  projectId: string,
  projectNamesById: ReadonlyMap<string, string>,
): string | null {
  return projectId === PERSONAL_PROJECT_ID
    ? null
    : (projectNamesById.get(projectId) ?? null);
}

function serverRow(
  thread: ThreadListEntry,
  matches: readonly ThreadSearchMatch[],
  lifecycle: ThreadArchiveFilter,
  projectNamesById: ReadonlyMap<string, string>,
  now: number,
): PaletteThreadSearchRow {
  const title = getThreadDisplayTitle(thread);
  const titleMatch = matches.find(
    (match) => isTitleMatch(match) && match.text === title,
  );
  const snippetMatch =
    titleMatch === undefined
      ? matches.find((match) => !isTitleMatch(match))
      : undefined;
  const primaryMatch = titleMatch ?? snippetMatch;
  return {
    id: `${lifecycle}:${thread.id}`,
    lifecycle,
    primaryText: primaryMatch?.text ?? title,
    highlightRanges: primaryMatch?.highlightRanges ?? [],
    secondaryTitle: snippetMatch === undefined ? null : title,
    projectName: projectMetadata(thread.projectId, projectNamesById),
    relativeTime: formatRelativeTime({ timestamp: thread.updatedAt, now }),
    projectId: thread.projectId,
    threadId: thread.id,
    thread,
  };
}

export function buildPaletteThreadSearchRows({
  lifecycles,
  now,
  projectNamesById,
  query,
  recentThreads,
  searchResponse,
  searchResultsAreCurrent,
}: BuildPaletteThreadSearchRowsArgs): PaletteThreadSearchRowsResult {
  const trimmedQuery = query.trim();
  const isRecent = trimmedQuery.length === 0;
  const isSearchable = trimmedQuery.length >= 2;
  return {
    isRecent,
    rows: normalizeThreadLifecycleFilter(lifecycles).flatMap((lifecycle) =>
      isRecent
        ? stablePartitionByPinned(
            recentThreads
              .filter((thread) =>
                lifecycle === "archived"
                  ? thread.archivedAt !== null
                  : thread.archivedAt === null,
              )
              .sort((left, right) =>
                lifecycle === "archived"
                  ? (right.archivedAt ?? 0) - (left.archivedAt ?? 0)
                  : right.updatedAt - left.updatedAt,
              )
              .slice(0, RECENT_THREAD_LIMIT),
            (thread) => thread.pinnedAt !== null,
          ).map((thread) =>
            serverRow(thread, [], lifecycle, projectNamesById, now),
          )
        : isSearchable && searchResultsAreCurrent
          ? (searchResponse?.[lifecycle]?.results ?? []).map((result) =>
              serverRow(
                result.thread,
                result.matches,
                lifecycle,
                projectNamesById,
                now,
              ),
            )
          : [],
    ),
  };
}
