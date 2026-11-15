const DAY_MS = 86_400_000;

export const EXTERNAL_WORKTREE_REMOVAL_LIMIT = 500;

type SelectableWorktree = {
  path: string;
  lastUsedAt: number | null;
  sizeBytes: number;
  locked: boolean;
  changedFileCount: number | null;
  unsavedCommitCount: number | null;
};

export function selectExternalWorktrees<T extends SelectableWorktree>(
  worktrees: T[],
  unusedForDays: number | null,
  now: number,
): T[] {
  return worktrees.filter(
    (worktree) =>
      unusedForDays === null ||
      (worktree.lastUsedAt !== null &&
        worktree.lastUsedAt <= now - unusedForDays * DAY_MS),
  );
}

export function needsForce(worktree: SelectableWorktree): boolean {
  return (
    worktree.locked ||
    (worktree.changedFileCount ?? 0) > 0 ||
    (worktree.unsavedCommitCount ?? 0) > 0
  );
}

export function limitExternalWorktrees<T>(worktrees: T[]): T[] {
  return worktrees.slice(0, EXTERNAL_WORKTREE_REMOVAL_LIMIT);
}
