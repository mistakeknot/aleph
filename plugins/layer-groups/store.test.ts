import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { afterEach, expect, it } from "vitest";
import { parseRegistry } from "./registry";
import { openStore, RUN_HISTORY_LIMIT, type LayerSectionRow } from "./store";

const databases: Database.Database[] = [];
afterEach(() => databases.splice(0).forEach((db) => db.close()));

function setup() {
  const db = new Database(":memory:");
  databases.push(db);
  return {
    db,
    store: openStore(db, (database, statements) => {
      for (const statement of statements) database.exec(statement);
    }),
  };
}

const row: LayerSectionRow = {
  layer: "B",
  sectionId: "fashion",
  state: "active",
  createdName: "B · Fashion",
  disabledReason: null,
  updatedAt: 10,
};

it("retains the newest 200 runs and returns the latest report", () => {
  const { store } = setup();
  expect(store.lastRun()).toBeNull();
  expect(RUN_HISTORY_LIMIT).toBe(200);
  for (let at = 0; at <= RUN_HISTORY_LIMIT; at++) {
    store.recordRun({
      kind: "provision",
      mode: "preview",
      at,
      report: {
        mode: "preview",
        applied: false,
        actions: [],
        errors: [`run ${at}`],
      },
    });
  }
  const runs = store.exportAll().runs;
  expect(runs).toHaveLength(200);
  expect(runs[0]).toMatchObject({ id: 2, at: 1 });
  expect(runs.at(-1)).toMatchObject({ id: 201, at: 200 });
  expect(store.lastRun()).toEqual({
    mode: "preview",
    applied: false,
    actions: [],
    errors: ["run 200"],
  });
});

it("rolls back the inserted run when pruning fails", () => {
  const { db, store } = setup();
  const run = {
    kind: "provision",
    mode: "preview" as const,
    at: 0,
    report: {
      mode: "preview" as const,
      applied: false,
      actions: [],
      errors: [],
    },
  };
  for (let at = 0; at < 200; at++) store.recordRun({ ...run, at });
  db.exec(
    "CREATE TRIGGER fail_prune BEFORE DELETE ON runs BEGIN SELECT RAISE(ABORT, 'prune failed'); END",
  );
  expect(() => store.recordRun({ ...run, at: 200 })).toThrow("prune failed");
  expect(store.exportAll().runs).toHaveLength(200);
  expect(store.exportAll().runs[0]).toMatchObject({ id: 1, at: 0 });
  expect(store.exportAll().runs.at(-1)).toMatchObject({ id: 200, at: 199 });
});

it("rolls back writes when a transaction throws", () => {
  const { store } = setup();
  expect(() =>
    store.transaction(() => {
      store.upsertLayerSection(row);
      throw new Error("rollback");
    }),
  ).toThrow("rollback");
  expect(store.layerSections()).toEqual([]);
});

it("upserts rows, updates state, and enforces unique section ownership", () => {
  const { store } = setup();
  store.upsertLayerSection(row);
  store.upsertLayerSection({ ...row, updatedAt: 11 });
  expect(store.layerSections()).toEqual([{ ...row, updatedAt: 11 }]);
  expect(() => store.upsertLayerSection({ ...row, layer: "C" })).toThrow();
  store.setLayerState("B", "disabled", "section-deleted", 12);
  expect(store.layerSections()).toEqual([
    {
      ...row,
      state: "disabled",
      disabledReason: "section-deleted",
      updatedAt: 12,
    },
  ]);
  store.transaction(() => store.removeLayerSection("B"));
  expect(store.layerSections()).toEqual([]);
});

it("re-enables only disabled rows and records the old row atomically", () => {
  const { db, store } = setup();
  expect(store.reenableLayer("B", 20)).toBe(false);
  store.upsertLayerSection(row);
  expect(store.reenableLayer("B", 20)).toBe(false);
  expect(store.exportAll().runs).toEqual([]);
  store.setLayerState("B", "disabled", "section-deleted", 12);
  const old = store.layerSections()[0];
  db.exec(
    "CREATE TRIGGER fail_run BEFORE INSERT ON runs BEGIN SELECT RAISE(ABORT, 'run failed'); END",
  );
  expect(() => store.reenableLayer("B", 20)).toThrow("run failed");
  expect(store.layerSections()).toEqual([old]);
  db.exec("DROP TRIGGER fail_run");
  expect(store.reenableLayer("B", 20)).toBe(true);
  expect(store.layerSections()).toEqual([]);
  expect(store.exportAll().runs).toEqual([
    expect.objectContaining({
      kind: "enable-layer",
      at: 20,
      report_json: expect.stringContaining(JSON.stringify(old)),
    }),
  ]);
});

it("persists and replaces snapshots and exports all five collections", () => {
  const { db, store } = setup();
  expect(store.exportAll()).toEqual({
    layerSections: [],
    assignments: [],
    overrides: [],
    snapshot: null,
    runs: [],
  });
  const snapshot = parseRegistry(
    readFileSync(new URL("./test/fixtures/registry-v4.json", import.meta.url)),
    { sha256: "fixture", readAt: 10, commit: null, dirty: null },
  );
  store.saveSnapshot(snapshot);
  store.saveSnapshot({ ...snapshot, readAt: 20 });
  expect(store.lastSnapshot()).toEqual({ ...snapshot, readAt: 20 });
  db.exec(
    "INSERT INTO assignments(thread_id, outcome, at) VALUES ('thread-1', 'moved', 20); INSERT INTO overrides(thread_id, source, detected_at) VALUES ('thread-1', 'manual', 20)",
  );
  const report = {
    mode: "preview" as const,
    applied: false,
    actions: [],
    errors: [],
  };
  store.recordRun({ kind: "provision", mode: "preview", at: 20, report });
  expect(store.exportAll()).toMatchObject({
    assignments: [{ thread_id: "thread-1" }],
    overrides: [{ thread_id: "thread-1" }],
    snapshot: { ...snapshot, readAt: 20 },
    runs: [{ report_json: JSON.stringify(report) }],
  });
});
