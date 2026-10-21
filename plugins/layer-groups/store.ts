import type Database from "better-sqlite3";
import { z } from "zod";
import type { LayerSnapshot } from "./registry";
import type { ProvisionReport } from "./provision";

export const RUN_HISTORY_LIMIT = 200;

export const MIGRATIONS: string[] = [
  `CREATE TABLE layer_sections (
    layer TEXT PRIMARY KEY,
    section_id TEXT NOT NULL UNIQUE,
    state TEXT NOT NULL CHECK (state IN ('adopting','active','disabled')),
    created_name TEXT NOT NULL,
    disabled_reason TEXT,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE assignments (
    id INTEGER PRIMARY KEY,
    thread_id TEXT NOT NULL,
    layer TEXT,
    section_id TEXT,
    from_section_id TEXT,
    outcome TEXT NOT NULL,
    at INTEGER NOT NULL
  );
  CREATE TABLE overrides (
    thread_id TEXT PRIMARY KEY,
    section_id TEXT,
    source TEXT NOT NULL,
    detected_at INTEGER NOT NULL
  );
  CREATE TABLE snapshots (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    sha256 TEXT NOT NULL,
    json TEXT NOT NULL,
    read_at INTEGER NOT NULL
  );
  CREATE TABLE runs (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL,
    mode TEXT NOT NULL,
    at INTEGER NOT NULL,
    report_json TEXT NOT NULL
  );`,
];

export interface LayerSectionRow {
  layer: string;
  sectionId: string;
  state: "adopting" | "active" | "disabled";
  createdName: string;
  disabledReason: string | null;
  updatedAt: number;
}

export interface LayerGroupsStore {
  layerSections(): LayerSectionRow[];
  transaction<T>(fn: () => T): T;
  upsertLayerSection(row: LayerSectionRow): void;
  setLayerState(
    layer: string,
    state: LayerSectionRow["state"],
    reason: string | null,
    at: number,
  ): void;
  removeLayerSection(layer: string): void;
  reenableLayer(layer: string, at: number): boolean;
  saveSnapshot(snapshot: LayerSnapshot): void;
  lastSnapshot(): LayerSnapshot | null;
  lastRun(): unknown;
  recordRun(run: {
    kind: string;
    mode: "preview" | "apply";
    at: number;
    report: ProvisionReport;
  }): void;
  exportAll(): {
    layerSections: LayerSectionRow[];
    assignments: unknown[];
    overrides: unknown[];
    snapshot: LayerSnapshot | null;
    runs: unknown[];
  };
}

const layerSectionSchema = z.object({
  layer: z.string(),
  sectionId: z.string(),
  state: z.enum(["adopting", "active", "disabled"]),
  createdName: z.string(),
  disabledReason: z.string().nullable(),
  updatedAt: z.number(),
});

const snapshotSchema: z.ZodType<LayerSnapshot> = z.object({
  catalogVersion: z.literal("4"),
  sha256: z.string(),
  commit: z.string().nullable(),
  dirty: z.boolean().nullable(),
  readAt: z.number(),
  layers: z.array(
    z.object({
      key: z.string(),
      letter: z.string(),
      name: z.string(),
      rank: z.number().nullable(),
      order: z.number(),
      accent: z.string(),
    }),
  ),
  hulls: z.array(
    z.object({
      slug: z.string().nullable(),
      project: z.string().nullable(),
      layer: z.string(),
    }),
  ),
});

const layerColumns = `layer, section_id AS sectionId, state, created_name AS createdName,
  disabled_reason AS disabledReason, updated_at AS updatedAt`;

export function openStore(
  db: Database.Database,
  migrate: (db: Database.Database, statements: string[]) => void,
): LayerGroupsStore {
  migrate(db, MIGRATIONS);
  const store: LayerGroupsStore = {
    layerSections() {
      return z
        .array(layerSectionSchema)
        .parse(
          db
            .prepare(
              `SELECT ${layerColumns} FROM layer_sections ORDER BY layer`,
            )
            .all(),
        );
    },
    transaction: (fn) => db.transaction(fn)(),
    upsertLayerSection(row) {
      db.prepare(`INSERT INTO layer_sections (layer, section_id, state, created_name, disabled_reason, updated_at)
        VALUES (@layer, @sectionId, @state, @createdName, @disabledReason, @updatedAt)
        ON CONFLICT(layer) DO UPDATE SET section_id=excluded.section_id, state=excluded.state,
          created_name=excluded.created_name, disabled_reason=excluded.disabled_reason, updated_at=excluded.updated_at`).run(
        row,
      );
    },
    setLayerState(layer, state, reason, at) {
      db.prepare(
        "UPDATE layer_sections SET state=?, disabled_reason=?, updated_at=? WHERE layer=?",
      ).run(state, reason, at, layer);
    },
    removeLayerSection(layer) {
      db.prepare("DELETE FROM layer_sections WHERE layer=?").run(layer);
    },
    reenableLayer(layer, at) {
      return store.transaction(() => {
        const value = db
          .prepare(
            `SELECT ${layerColumns} FROM layer_sections WHERE layer=? AND state='disabled'`,
          )
          .get(layer);
        if (!value) return false;
        const previousRow = layerSectionSchema.parse(value);
        store.removeLayerSection(layer);
        const report = {
          mode: "apply" as const,
          applied: true,
          actions: [],
          errors: [],
          previousRow,
        };
        store.recordRun({ kind: "enable-layer", mode: "apply", at, report });
        return true;
      });
    },
    saveSnapshot(snapshot) {
      db.prepare(`INSERT INTO snapshots (id, sha256, json, read_at) VALUES (1, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET sha256=excluded.sha256, json=excluded.json, read_at=excluded.read_at`).run(
        snapshot.sha256,
        JSON.stringify(snapshot),
        snapshot.readAt,
      );
    },
    lastSnapshot() {
      const value = db.prepare("SELECT json FROM snapshots WHERE id=1").get();
      if (!value) return null;
      const { json } = z.object({ json: z.string() }).parse(value);
      return snapshotSchema.parse(JSON.parse(json));
    },
    recordRun(run) {
      store.transaction(() => {
        db.prepare(
          "INSERT INTO runs (kind, mode, at, report_json) VALUES (?, ?, ?, ?)",
        ).run(run.kind, run.mode, run.at, JSON.stringify(run.report));
        db.prepare(
          "DELETE FROM runs WHERE id NOT IN (SELECT id FROM runs ORDER BY id DESC LIMIT ?)",
        ).run(RUN_HISTORY_LIMIT);
      });
    },
    lastRun() {
      const row = db
        .prepare("SELECT report_json FROM runs ORDER BY id DESC LIMIT 1")
        .get();
      if (!row) return null;
      const { report_json } = z.object({ report_json: z.string() }).parse(row);
      const report: unknown = JSON.parse(report_json);
      return report;
    },
    exportAll() {
      return store.transaction(() => ({
        layerSections: store.layerSections(),
        assignments: db.prepare("SELECT * FROM assignments ORDER BY id").all(),
        overrides: db
          .prepare("SELECT * FROM overrides ORDER BY thread_id")
          .all(),
        snapshot: store.lastSnapshot(),
        runs: db.prepare("SELECT * FROM runs ORDER BY id").all(),
      }));
    },
  };
  return store;
}
