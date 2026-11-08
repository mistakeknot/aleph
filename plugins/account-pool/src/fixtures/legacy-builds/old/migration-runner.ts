import { createHash } from "node:crypto";
import type Database from "better-sqlite3";

const LEGACY_UNKNOWN_MIGRATION_HASH = "legacy-unknown";

function migrationStatementHash(statement: string): string {
  return createHash("sha256").update(statement).digest("hex");
}

export function runPluginStorageMigrations(
  database: Database.Database,
  statements: string[],
): void {
  database.exec(
    "CREATE TABLE IF NOT EXISTS _bb_migrations (id INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL, statement_hash TEXT)",
  );
  const migrationColumns = database
    .prepare<[], { name: string }>("PRAGMA table_info(_bb_migrations)")
    .all();
  if (!migrationColumns.some((column) => column.name === "statement_hash")) {
    database.exec("ALTER TABLE _bb_migrations ADD COLUMN statement_hash TEXT");
  }
  const rows = database
    .prepare<
      [],
      { id: number; statement_hash: string | null }
    >("SELECT id, statement_hash FROM _bb_migrations ORDER BY id")
    .all();
  const applied = new Map<number, string | null>();
  for (const row of rows) applied.set(row.id, row.statement_hash);
  const statementHashes = statements.map(migrationStatementHash);
  statementHashes.forEach((statementHash, index) => {
    const recordedHash = applied.get(index);
    if (
      recordedHash !== undefined &&
      recordedHash !== null &&
      recordedHash !== statementHash
    ) {
      throw new Error(
        `migration ${index} does not match the recorded statement; append a new migration instead of changing or reusing an index`,
      );
    }
  });
  const adopt = database.prepare(
    "UPDATE _bb_migrations SET statement_hash = ? WHERE id = ? AND statement_hash IS NULL",
  );
  const record = database.prepare(
    "INSERT INTO _bb_migrations (id, applied_at, statement_hash) VALUES (?, ?, ?)",
  );
  database.transaction(() => {
    for (const row of rows) {
      if (row.statement_hash !== null) continue;
      adopt.run(
        statementHashes[row.id] ?? LEGACY_UNKNOWN_MIGRATION_HASH,
        row.id,
      );
    }
    statements.forEach((statement, index) => {
      if (applied.has(index)) return;
      database.exec(statement);
      record.run(index, Date.now(), statementHashes[index]);
    });
  })();
}
