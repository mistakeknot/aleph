import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { materializeLegacyCompatibleFolder } from "../../src/legacy-compat-folder.js";
import { splitMigrationStatements } from "../../src/migration-guard.js";
import {
  loadMigrationPlan,
  loadMigrationPlanInput,
  planStepPath,
  type MigrationPlanFolders,
  type MigrationPlanStep,
} from "../../src/migration-plan.js";

const here = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(here, "..", "..");

export const sourceFolders: MigrationPlanFolders = {
  upstreamFolder: join(packageDir, "drizzle"),
  alephFolder: join(packageDir, "drizzle-aleph"),
};

export function stageEmptyMigrationTables(sqlite: Database.Database): void {
  sqlite.exec(
    "CREATE TEMP TABLE IF NOT EXISTS bb_migration_existing_installation (existing INTEGER NOT NULL)",
  );
  sqlite.exec("DELETE FROM bb_migration_existing_installation");
  sqlite.exec("INSERT INTO bb_migration_existing_installation VALUES (0)");
  sqlite.exec(
    "CREATE TEMP TABLE IF NOT EXISTS bb_migration_local_host (id TEXT PRIMARY KEY)",
  );
  sqlite.exec(
    "CREATE TEMP TABLE IF NOT EXISTS bb_migration_queued_message_groups (id TEXT PRIMARY KEY, group_with_next INTEGER NOT NULL)",
  );
}

export function applySteps(
  sqlite: Database.Database,
  folders: MigrationPlanFolders,
  steps: readonly Pick<MigrationPlanStep, "namespace" | "file">[],
): void {
  sqlite.pragma("foreign_keys = OFF");
  stageEmptyMigrationTables(sqlite);
  for (const step of steps) {
    for (const statement of splitMigrationStatements(
      readFileSync(planStepPath(folders, step), "utf8"),
    )) {
      sqlite.exec(statement);
    }
  }
}

export function applyPlan(
  folders: MigrationPlanFolders = sourceFolders,
): Database.Database {
  const sqlite = new Database(":memory:");
  applySteps(sqlite, folders, loadMigrationPlan(folders).steps);
  return sqlite;
}

export function applyUpstreamOnly(
  folders: MigrationPlanFolders = sourceFolders,
): Database.Database {
  const sqlite = new Database(":memory:");
  const steps = loadMigrationPlanInput(folders).upstream.map((step) => ({
    namespace: "upstream" as const,
    file: `${step.tag}.sql`,
  }));
  applySteps(sqlite, folders, steps);
  return sqlite;
}

export function legacyCompatFolder(): string {
  return materializeLegacyCompatibleFolder(sourceFolders);
}
