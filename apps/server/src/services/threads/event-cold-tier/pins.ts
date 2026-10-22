const pinCounts = new Map<string, number>();

export type ThreadHistoryPinRelease = () => void;

export function pinThreadHistory(threadId: string): ThreadHistoryPinRelease {
  pinCounts.set(threadId, (pinCounts.get(threadId) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    const next = (pinCounts.get(threadId) ?? 1) - 1;
    if (next <= 0) {
      pinCounts.delete(threadId);
    } else {
      pinCounts.set(threadId, next);
    }
  };
}

export function pinThreadHistories(
  threadIds: Iterable<string>,
): ThreadHistoryPinRelease {
  const releases = [...new Set(threadIds)].sort().map(pinThreadHistory);
  return () => {
    for (const release of releases) {
      release();
    }
  };
}

export function getThreadHistoryPinCount(threadId: string): number {
  return pinCounts.get(threadId) ?? 0;
}

export function listPinnedThreadHistoryIds(): string[] {
  return [...pinCounts.keys()].sort();
}
