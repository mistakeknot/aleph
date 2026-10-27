import {
  MIGRATION_WAIT_CAP_MS,
  readActiveMigration,
  type MigrationHolderInfo,
} from "@bb/config/migration-info";

export const MIGRATION_PROGRESS_LOG_INTERVAL_MS = 10_000;

export interface HealthDeadline {
  isExpired(): boolean;
  migrationElapsedMs(): number;
}

export interface CreateHealthDeadlineArgs {
  databasePath: string | null;
  timeoutMs: number;
  capMs?: number;
  now?: () => number;
  readMigration?: (databasePath: string) => MigrationHolderInfo | null;
  progressIntervalMs?: number;
  onProgress?: (info: MigrationHolderInfo, elapsedMs: number) => void;
}

export function createHealthDeadline(
  args: CreateHealthDeadlineArgs,
): HealthDeadline {
  const now = args.now ?? Date.now;
  const capMs = args.capMs ?? MIGRATION_WAIT_CAP_MS;
  const readMigration = args.readMigration ?? readActiveMigration;
  const progressIntervalMs =
    args.progressIntervalMs ?? MIGRATION_PROGRESS_LOG_INTERVAL_MS;
  let deadline = now() + args.timeoutMs;
  let migrationStartedAt: number | null = null;
  let lastProgressAt = Number.NEGATIVE_INFINITY;
  let lastElapsedMs = 0;

  return {
    isExpired(): boolean {
      const current = now();
      if (args.databasePath !== null) {
        const info = readMigration(args.databasePath);
        if (info !== null) {
          migrationStartedAt ??= current;
          lastElapsedMs = current - migrationStartedAt;
          if (lastElapsedMs <= capMs) {
            deadline = Math.max(deadline, current + args.timeoutMs);
            if (current - lastProgressAt >= progressIntervalMs) {
              lastProgressAt = current;
              args.onProgress?.(info, lastElapsedMs);
            }
          }
        }
      }
      return current > deadline;
    },
    migrationElapsedMs: () => lastElapsedMs,
  };
}

export function isMigrationActive(
  databasePath: string,
  readMigration: (
    databasePath: string,
  ) => MigrationHolderInfo | null = readActiveMigration,
): boolean {
  return readMigration(databasePath) !== null;
}
