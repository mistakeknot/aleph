import type Database from "better-sqlite3";
import type { DbConnection } from "../../src/connection.js";
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
const CLOCK_WINDOW_MS = 24 * 60 * 60 * 1000;

export function pinMigrationClock(sqlite: Database.Database): void {
  const floor = Date.now() - CLOCK_WINDOW_MS;
  const tables = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all() as Array<{ name: string }>;
  for (const { name } of tables) {
    const columns = sqlite
      .prepare(`SELECT name FROM pragma_table_info('${name}')`)
      .all() as Array<{ name: string }>;
    const names = new Set(columns.map((column) => column.name));
    if (names.has("updated_at"))
      sqlite
        .prepare(`UPDATE "${name}" SET updated_at = ? WHERE updated_at >= ?`)
        .run(PINNED_CLOCK_MS, floor);
    if (name === "app_settings" && names.has("onboarding_completed_at"))
      sqlite
        .prepare(
          "UPDATE app_settings SET onboarding_completed_at = ? WHERE onboarding_completed_at >= ?",
        )
        .run(PINNED_CLOCK_ISO, new Date(floor).toISOString());
    if (name === "app_settings_values")
      sqlite
        .prepare(
          "UPDATE app_settings_values SET value = ? WHERE key = 'onboardingCompletedAt'",
        )
        .run(JSON.stringify(PINNED_CLOCK_ISO));
  }
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

export async function legacyMigrate(db: DbConnection): Promise<void> {
  const { migrate } = await loadLegacyRunner();
  migrate(db);
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
