import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createConnection, migrate, type DbConnection } from "../src/index.js";

describe("migrate when SQLite aborts the transaction", () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
  });

  function createConnectionWithAbortingTrigger(): DbConnection {
    const dir = mkdtempSync(join(tmpdir(), "bb-migrate-abort-"));
    const db = createConnection(join(dir, "bb.db"));
    cleanups.push(() => {
      db.$client.close();
      rmSync(dir, { recursive: true, force: true });
    });
    db.$client.exec(
      "CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY, hash text NOT NULL, created_at numeric)",
    );
    db.$client.exec(
      "CREATE TRIGGER abort_migration_record BEFORE INSERT ON __drizzle_migrations BEGIN SELECT RAISE(ROLLBACK, 'injected migration failure'); END",
    );
    return db;
  }

  it("surfaces the SQLite error instead of drizzle's ROLLBACK failure", () => {
    const db = createConnectionWithAbortingTrigger();

    let caught: unknown = null;
    try {
      migrate(db);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    const error = caught as Error;
    expect(error.message).toContain("injected migration failure");
    expect(error.message).not.toMatch(/^Failed to run the query 'ROLLBACK'/u);
    expect(error.cause).toBeInstanceOf(Error);
    expect((error.cause as Error).message).toContain(
      "injected migration failure",
    );
  });

  it("still migrates a fresh database with enough space", () => {
    const dir = mkdtempSync(join(tmpdir(), "bb-migrate-fresh-"));
    const db = createConnection(join(dir, "bb.db"));
    cleanups.push(() => {
      db.$client.close();
      rmSync(dir, { recursive: true, force: true });
    });
    expect(() => migrate(db)).not.toThrow();
  });
});
