import type { Database } from "better-sqlite3";

export interface StoreMigration {
  version: number;
  name: string;
  stagingPages: number;
  requiresReset?: boolean;
  up(db: Database): void;
}

export const INITIAL_MIGRATION: StoreMigration = {
  version: 1,
  name: "initial",
  stagingPages: 0,
  up(db) {
    db.exec(`
      CREATE TABLE meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) WITHOUT ROWID;

      CREATE TABLE source_generation (
        id INTEGER PRIMARY KEY,
        source_key TEXT NOT NULL,
        generation INTEGER NOT NULL,
        first_discovery_ms INTEGER NOT NULL
          CHECK (first_discovery_ms >= 0 AND first_discovery_ms < 8796093022208),
        UNIQUE (source_key, generation)
      );

      CREATE TABLE source_cursor (
        source_id INTEGER PRIMARY KEY REFERENCES source_generation(id) ON DELETE CASCADE,
        position TEXT NOT NULL,
        updated_ms INTEGER NOT NULL
      );

      CREATE TABLE ms_counter (
        event_ms INTEGER PRIMARY KEY
          CHECK (event_ms >= 0 AND event_ms < 8796093022208),
        next_counter INTEGER NOT NULL
          CHECK (next_counter >= 0 AND next_counter <= 1048576)
      ) WITHOUT ROWID;

      CREATE TABLE content (
        id INTEGER PRIMARY KEY,
        source_id INTEGER NOT NULL REFERENCES source_generation(id) ON DELETE CASCADE,
        dedupe_key TEXT NOT NULL,
        kind TEXT NOT NULL,
        provider TEXT NOT NULL,
        session_id TEXT,
        agent_id TEXT,
        sidechain INTEGER NOT NULL,
        call_id TEXT,
        name TEXT,
        cwd TEXT,
        event_ms INTEGER NOT NULL,
        time_basis TEXT NOT NULL CHECK (time_basis IN ('event', 'discovery')),
        text TEXT NOT NULL
      );

      CREATE UNIQUE INDEX content_dedupe ON content(dedupe_key);
      CREATE INDEX content_source ON content(source_id);

      CREATE TABLE identity (
        dedupe_key TEXT PRIMARY KEY,
        content_id INTEGER NOT NULL UNIQUE,
        source_id INTEGER NOT NULL REFERENCES source_generation(id) ON DELETE CASCADE
      ) WITHOUT ROWID;

      CREATE INDEX identity_source ON identity(source_id);

      CREATE TABLE touch (
        content_id INTEGER NOT NULL REFERENCES content(id) ON DELETE CASCADE,
        path TEXT NOT NULL,
        access TEXT NOT NULL,
        confidence TEXT NOT NULL,
        PRIMARY KEY (content_id, path, access)
      ) WITHOUT ROWID;

      CREATE INDEX touch_path ON touch(path, content_id);

      CREATE TABLE quarantine (
        id INTEGER PRIMARY KEY,
        source_id INTEGER NOT NULL REFERENCES source_generation(id) ON DELETE CASCADE,
        dedupe_key TEXT NOT NULL UNIQUE,
        reason TEXT NOT NULL,
        event_ms INTEGER,
        created_ms INTEGER NOT NULL
      );

      CREATE VIRTUAL TABLE content_fts USING fts5(
        text,
        content='content',
        content_rowid='id',
        tokenize='unicode61'
      );

      CREATE TRIGGER content_ai AFTER INSERT ON content BEGIN
        INSERT INTO content_fts(rowid, text) VALUES (new.id, new.text);
      END;

      CREATE TRIGGER content_ad AFTER DELETE ON content BEGIN
        INSERT INTO content_fts(content_fts, rowid, text)
          VALUES ('delete', old.id, old.text);
      END;

      CREATE TRIGGER content_au AFTER UPDATE OF text ON content BEGIN
        INSERT INTO content_fts(content_fts, rowid, text)
          VALUES ('delete', old.id, old.text);
        INSERT INTO content_fts(rowid, text) VALUES (new.id, new.text);
      END;

      INSERT INTO meta(key, value) VALUES ('rowid_epoch', '0');
      INSERT INTO meta(key, value) VALUES ('fts_automerge', '4');
      INSERT INTO content_fts(content_fts, rank) VALUES ('automerge', 4);
      INSERT INTO content_fts(content_fts, rank) VALUES ('crisismerge', 16);
    `);
  },
};

export const MIGRATIONS: readonly StoreMigration[] = [INITIAL_MIGRATION];

export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;

export function validateMigrations(
  migrations: readonly StoreMigration[],
): void {
  if (migrations.length === 0) {
    throw new Error("at least one migration is required");
  }
  migrations.forEach((migration, index) => {
    if (migration.version !== index + 1) {
      throw new Error(
        `migration versions must be contiguous from 1; found ${migration.version} at index ${index}`,
      );
    }
    if (
      !Number.isInteger(migration.stagingPages) ||
      migration.stagingPages < 0
    ) {
      throw new Error(
        `migration ${migration.version} has an invalid stagingPages`,
      );
    }
  });
}
