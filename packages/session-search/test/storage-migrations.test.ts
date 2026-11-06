import Database from "better-sqlite3";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { INITIAL_MIGRATION, validateMigrations } from "../src/migrations.js";
import type { StoreMigration } from "../src/migrations.js";
import {
  openReadonlyConnection,
  resetStore,
  StoreError,
  type SessionSearchStore,
} from "../src/storage.js";
import {
  batchOf,
  cleanupStoreDirs,
  makeStoreDir,
  message,
  source,
  openTestStore,
} from "./support/store-helpers.js";

const MS = 1_700_000_000_000;
const open: SessionSearchStore[] = [];

function track(store: SessionSearchStore): SessionSearchStore {
  open.push(store);
  return store;
}

afterEach(() => {
  while (open.length > 0) open.pop()!.close();
  cleanupStoreDirs();
});

const V2: StoreMigration = {
  version: 2,
  name: "add-note-table",
  stagingPages: 0,
  up(db) {
    db.exec(
      "CREATE TABLE note (id INTEGER PRIMARY KEY, body TEXT NOT NULL); INSERT INTO note(body) VALUES ('migrated');",
    );
  },
};

function userVersion(dir: string): number {
  const db = openReadonlyConnection(dir);
  try {
    return db.pragma("user_version", { simple: true }) as number;
  } finally {
    db.close();
  }
}

function seed(store: SessionSearchStore): void {
  const result = store.commitBatch(
    batchOf(source(), [message("m1", "keepme survives migration", MS)]),
    { expected: null, next: "c1" },
  );
  expect(result.committed).toBe(true);
}

describe("migration runner", () => {
  it("validates contiguous versions and staging pages", () => {
    expect(() => validateMigrations([])).toThrow();
    expect(() =>
      validateMigrations([INITIAL_MIGRATION, { ...V2, version: 3 }]),
    ).toThrow(/contiguous/);
    expect(() =>
      validateMigrations([INITIAL_MIGRATION, { ...V2, stagingPages: -1 }]),
    ).toThrow(/stagingPages/);
    expect(() => validateMigrations([INITIAL_MIGRATION, V2])).not.toThrow();
  });

  it("creates a fresh store at the latest version", () => {
    const dir = makeStoreDir();
    const store = track(
      openTestStore(dir, { migrations: [INITIAL_MIGRATION, V2] }),
    );
    expect(store.schemaVersion).toBe(2);
    expect(userVersion(dir)).toBe(2);
  });

  it("migrates an existing v1 store forward and keeps its data", () => {
    const dir = makeStoreDir();
    const v1 = track(openTestStore(dir));
    seed(v1);
    v1.close();
    open.pop();
    const v2 = track(
      openTestStore(dir, { migrations: [INITIAL_MIGRATION, V2] }),
    );
    expect(v2.schemaVersion).toBe(2);
    expect(v2.getCursor(source())).toBe("c1");
    expect(v2.lookupIdentity("fx:m1")).not.toBeNull();
    const db = openReadonlyConnection(dir);
    try {
      expect(db.prepare("SELECT body FROM note").all()).toEqual([
        { body: "migrated" },
      ]);
    } finally {
      db.close();
    }
    expect(v2.integrityCheck().ok).toBe(true);
  });

  it("rolls a failing migration back atomically and leaves the version", () => {
    const dir = makeStoreDir();
    const v1 = track(openTestStore(dir));
    seed(v1);
    v1.close();
    open.pop();
    const broken: StoreMigration = {
      version: 2,
      name: "half-applied",
      stagingPages: 0,
      up(db) {
        db.exec("CREATE TABLE half (id INTEGER PRIMARY KEY)");
        db.exec("INSERT INTO no_such_table VALUES (1)");
      },
    };
    expect(() =>
      openTestStore(dir, { migrations: [INITIAL_MIGRATION, broken] }),
    ).toThrow(StoreError);
    try {
      openTestStore(dir, { migrations: [INITIAL_MIGRATION, broken] });
    } catch (error) {
      expect((error as StoreError).code).toBe("migration_failed");
    }
    expect(userVersion(dir)).toBe(1);
    const db = openReadonlyConnection(dir);
    try {
      expect(
        db.prepare("SELECT name FROM sqlite_master WHERE name = 'half'").all(),
      ).toEqual([]);
    } finally {
      db.close();
    }
    const again = track(openTestStore(dir));
    expect(again.lookupIdentity("fx:m1")).not.toBeNull();
  });

  it("refuses a store newer than the code understands", () => {
    const dir = makeStoreDir();
    const v2 = track(
      openTestStore(dir, { migrations: [INITIAL_MIGRATION, V2] }),
    );
    v2.close();
    open.pop();
    try {
      openTestStore(dir);
      throw new Error("expected schema_too_new");
    } catch (error) {
      expect(error).toBeInstanceOf(StoreError);
      expect((error as StoreError).code).toBe("schema_too_new");
    }
    expect(userVersion(dir)).toBe(2);
  });

  it("refuses a staging requirement that exceeds the page headroom", () => {
    const dir = makeStoreDir();
    const v1 = track(openTestStore(dir));
    seed(v1);
    v1.close();
    open.pop();
    const heavy: StoreMigration = { ...V2, stagingPages: 1_000_000_000 };
    try {
      openTestStore(dir, { migrations: [INITIAL_MIGRATION, heavy] });
      throw new Error("expected migration_no_headroom");
    } catch (error) {
      expect((error as StoreError).code).toBe("migration_no_headroom");
    }
    expect(userVersion(dir)).toBe(1);
  });

  it("requires an explicit reset for a schema bump that cannot migrate in place", () => {
    const dir = makeStoreDir();
    const v1 = track(openTestStore(dir));
    seed(v1);
    v1.close();
    open.pop();
    const bump: StoreMigration = {
      version: 2,
      name: "rowid-layout-change",
      stagingPages: 0,
      requiresReset: true,
      up(db) {
        db.exec("CREATE TABLE layout_marker (id INTEGER PRIMARY KEY)");
      },
    };
    const migrations = [INITIAL_MIGRATION, bump];
    try {
      openTestStore(dir, { migrations });
      throw new Error("expected reset_required");
    } catch (error) {
      expect((error as StoreError).code).toBe("reset_required");
    }
    expect(userVersion(dir)).toBe(1);
    expect(() =>
      resetStore(dir, {
        tempDirMode: "unmanaged",
        confirm: false as unknown as true,
        migrations,
      }),
    ).toThrow(StoreError);
    expect(userVersion(dir)).toBe(1);
    const { store, diagnostics } = resetStore(dir, {
      tempDirMode: "unmanaged",
      confirm: true,
      migrations,
    });
    track(store);
    expect(diagnostics.previousVersion).toBe(1);
    expect(diagnostics.previousContentCount).toBe(1);
    expect(diagnostics.previousSourceCount).toBe(1);
    expect(store.schemaVersion).toBe(2);
    expect(store.getCursor(source())).toBeNull();
    expect(store.lookupIdentity("fx:m1")).toBeNull();
    const result = store.commitBatch(
      batchOf(source(), [message("m1", "keepme survives migration", MS)]),
      { expected: null, next: "c1" },
    );
    expect(result.inserted).toBe(1);
  });

  it("resets a store whose file is not a database", () => {
    const dir = makeStoreDir();
    const first = track(openTestStore(dir));
    first.close();
    open.pop();
    const raw = new Database(join(dir, "session-search.sqlite3"));
    raw.close();
    const { store } = resetStore(dir, {
      tempDirMode: "unmanaged",
      confirm: true,
    });
    track(store);
    expect(store.schemaVersion).toBe(1);
  });

  it("refuses a store with the wrong auto-vacuum mode", () => {
    const dir = makeStoreDir();
    const first = track(openTestStore(dir));
    first.close();
    open.pop();
    const raw = new Database(join(dir, "session-search.sqlite3"));
    raw.pragma("auto_vacuum = NONE");
    raw.exec("VACUUM");
    raw.close();
    try {
      openTestStore(dir);
      throw new Error("expected config_mismatch");
    } catch (error) {
      expect((error as StoreError).code).toBe("config_mismatch");
    }
  });
});
