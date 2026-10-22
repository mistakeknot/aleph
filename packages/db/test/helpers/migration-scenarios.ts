import type Database from "better-sqlite3";
import type { DbConnection } from "../../src/connection.js";
import type { MigrateOptions } from "../../src/migrate.js";
import {
  applyFolder,
  applyPrefix,
  loadLegacyRunner,
  upstreamDrizzleFolder,
  materializeLegacyOracle,
} from "./legacy-oracle.js";
import { populateDatabase } from "./populate.js";

export const RELEASE_PREFIX_LENGTHS = [131, 134, 135, 141, 146, 152] as const;
export const EARLY_PREFIX_LENGTHS = [35, 64, 89, 119] as const;
export const GROUPED_PREFIX_LENGTHS = [35, 64, 146] as const;
export const EQUALITY_PREFIX_LENGTHS = [
  ...EARLY_PREFIX_LENGTHS,
  ...RELEASE_PREFIX_LENGTHS,
] as const;

export async function openLegacyConnection(): Promise<DbConnection> {
  const { createConnection } = await loadLegacyRunner();
  return createConnection(":memory:");
}

function pinSeededClock(sqlite: Database.Database): void {
  const hasProjects = sqlite
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'projects'",
    )
    .get();
  if (hasProjects)
    sqlite.exec(
      "UPDATE projects SET created_at = 1700000000000, updated_at = 1700000000000 WHERE id = 'proj_personal'",
    );
}

const PINNED_CLOCK_MS = 1_700_000_000_000;
const PINNED_CLOCK_ISO = new Date(PINNED_CLOCK_MS).toISOString();
const CLOCK_WINDOW_BEFORE_MS = 24 * 60 * 60 * 1000;
const CLOCK_WINDOW_AFTER_MS = 60 * 60 * 1000;

export interface PinnedCounts {
  updatedAt: Record<string, number>;
  onboardingCompletedAtColumn: number;
  onboardingCompletedAtValue: number;
}

function quoteName(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

export function pinMigrationClock(sqlite: Database.Database): PinnedCounts {
  const now = Date.now();
  const floor = now - CLOCK_WINDOW_BEFORE_MS;
  const ceiling = now + CLOCK_WINDOW_AFTER_MS;
  const counts: PinnedCounts = {
    updatedAt: {},
    onboardingCompletedAtColumn: 0,
    onboardingCompletedAtValue: 0,
  };
  const tables = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all() as Array<{ name: string }>;
  for (const { name } of tables) {
    const names = new Set(
      (
        sqlite
          .prepare("SELECT name FROM pragma_table_info(?)")
          .all(name) as Array<{ name: string }>
      ).map((column) => column.name),
    );
    if (names.has("updated_at")) {
      const changed = sqlite
        .prepare(
          `UPDATE ${quoteName(name)} SET updated_at = ? WHERE typeof(updated_at) = 'integer' AND updated_at BETWEEN ? AND ?`,
        )
        .run(PINNED_CLOCK_MS, floor, ceiling).changes;
      if (changed > 0) counts.updatedAt[name] = changed;
    }
    if (name === "app_settings" && names.has("onboarding_completed_at")) {
      const stamped = sqlite
        .prepare(
          "SELECT rowid, onboarding_completed_at AS value FROM app_settings WHERE typeof(onboarding_completed_at) = 'text'",
        )
        .all() as Array<{ rowid: number; value: string }>;
      for (const row of stamped) {
        const parsed = Date.parse(row.value);
        if (parsed >= floor && parsed <= ceiling) {
          sqlite
            .prepare(
              "UPDATE app_settings SET onboarding_completed_at = ? WHERE rowid = ?",
            )
            .run(PINNED_CLOCK_ISO, row.rowid);
          counts.onboardingCompletedAtColumn += 1;
        }
      }
    }
    if (name === "app_settings_values") {
      const row = sqlite
        .prepare(
          "SELECT value FROM app_settings_values WHERE key = 'onboardingCompletedAt'",
        )
        .get() as { value: string } | undefined;
      let parsedValue: unknown;
      try {
        parsedValue = row ? JSON.parse(row.value) : undefined;
      } catch {
        parsedValue = undefined;
      }
      if (typeof parsedValue === "string") {
        const parsed = Date.parse(parsedValue);
        if (parsed >= floor && parsed <= ceiling) {
          sqlite
            .prepare(
              "UPDATE app_settings_values SET value = ? WHERE key = 'onboardingCompletedAt'",
            )
            .run(JSON.stringify(PINNED_CLOCK_ISO));
          counts.onboardingCompletedAtValue += 1;
        }
      }
    }
  }
  return counts;
}

export interface GroupedFlags {
  [id: string]: number;
}

export async function groupedPrefixDatabase(
  length: number,
): Promise<{ db: DbConnection; flags: GroupedFlags }> {
  const db = await populatedPrefixDatabase(length);
  const sqlite = db.$client;
  const hasColumn = (sqlite
    .prepare(
      "SELECT 1 FROM pragma_table_info('queued_thread_messages') WHERE name = 'group_with_next'",
    )
    .get() as unknown)
    ? true
    : false;
  if (!hasColumn)
    sqlite.exec(
      "ALTER TABLE queued_thread_messages ADD COLUMN group_with_next integer NOT NULL DEFAULT 0",
    );
  sqlite.exec(
    "UPDATE queued_thread_messages SET group_with_next = CASE WHEN rowid % 2 = 1 THEN 1 ELSE 0 END",
  );
  const flags: GroupedFlags = {};
  for (const row of sqlite
    .prepare("SELECT id, group_with_next AS flag FROM queued_thread_messages")
    .all() as Array<{ id: string; flag: number }>)
    flags[row.id] = row.flag;
  return { db, flags };
}

export async function populatedPrefixDatabase(
  length: number,
): Promise<DbConnection> {
  const db = await openLegacyConnection();
  applyPrefix(db.$client, length);
  pinSeededClock(db.$client);
  const { failed } = populateDatabase(db.$client);
  if (Object.keys(failed).length > 0)
    throw new Error(`Populate failed: ${JSON.stringify(failed)}`);
  return db;
}

export async function populatedUpstreamDatabase(): Promise<DbConnection> {
  materializeLegacyOracle();
  const db = await openLegacyConnection();
  applyFolder(db.$client, upstreamDrizzleFolder);
  pinSeededClock(db.$client);
  const { failed } = populateDatabase(db.$client);
  if (Object.keys(failed).length > 0)
    throw new Error(`Populate failed: ${JSON.stringify(failed)}`);
  return db;
}

export async function legacyMigrate(
  db: DbConnection,
  options?: MigrateOptions,
): Promise<void> {
  const { migrate } = await loadLegacyRunner();
  migrate(db, options);
}

export function ledgerRows(
  sqlite: Database.Database,
): Array<{ rowid: number; hash: string; created_at: number | null }> {
  return sqlite
    .prepare(
      "SELECT rowid, hash, created_at FROM __drizzle_migrations ORDER BY rowid",
    )
    .all() as Array<{ rowid: number; hash: string; created_at: number | null }>;
}
