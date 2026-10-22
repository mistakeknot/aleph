import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  COLD_SEGMENT_FORMAT_VERSION,
  EVENT_COLD_COLUMNS,
} from "../../src/data/event-cold-tier.js";
import { COMPLETED_EVENT_OUTPUT_TRANSFORM_VERSIONS } from "../../src/data/sweeps.js";
import { createMigratedConnection } from "../../src/testing.js";

// Cold segments store events rows verbatim. A new migration that changes the
// events table, or a new rehydrate transform, changes what an old segment
// must become on its way back. These pins fail until the change says how old
// segments are handled: bump COLD_SEGMENT_FORMAT_VERSION with a reader for
// the old format, or add a transform version that rehydrate applies.

const PKG_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const DRIZZLE_DIR = path.join(PKG_DIR, "drizzle");
const EVENTS_TABLE_SQL =
  /\b(TABLE|INTO|UPDATE|FROM|ON|JOIN)\s+[`"]?events[`"]?([^A-Za-z0-9_]|$)/i;

const EVENTS_MIGRATIONS_AT_FORMAT_1 = [
  "0000_baseline",
  "0015_good_lila_cheney",
  "0016_salty_arclight",
  "0019_pending_interactions_schema_honesty",
  "0031_mysterious_zaran",
  "0032_restore_event_large_values",
  "0039_thread_search",
  "0078_permission_modes",
  "0088_narrow_kronos",
  "0089_chemical_darwin",
  "0099_flawless_maximus",
  "0100_flippant_psylocke",
  "0103_wandering_mongoose",
  "0104_chunky_redwing",
  "0106_thread_state_index",
  "0107_kind_based_indexes",
  "0116_majestic_swordsman",
  "0125_silent_guardian",
];

const REHYDRATE_TRANSFORMS = {
  completedEventOutputSidecar: 1,
  legacyImageGenerationOutputSidecar: 1,
};

function eventsMigrations(): string[] {
  return fs
    .readdirSync(DRIZZLE_DIR)
    .filter((name) => name.endsWith(".sql"))
    .filter((name) =>
      EVENTS_TABLE_SQL.test(
        fs.readFileSync(path.join(DRIZZLE_DIR, name), "utf8"),
      ),
    )
    .map((name) => name.replace(/\.sql$/, ""))
    .sort();
}

describe("cold segment schema compatibility", () => {
  it("EVENT_COLD_COLUMNS matches the migrated events table, in any order", () => {
    const db = createMigratedConnection();
    const columns = db.$client
      .prepare("SELECT name FROM pragma_table_info('events')")
      .all() as { name: string }[];
    expect(columns.map((column) => column.name).sort()).toEqual(
      [...EVENT_COLD_COLUMNS].sort(),
    );
  });

  it("no events migration lands without a cold segment format decision", () => {
    expect(COLD_SEGMENT_FORMAT_VERSION).toBe(1);
    expect(
      eventsMigrations(),
      "A migration touches the events table. Bump COLD_SEGMENT_FORMAT_VERSION " +
        "and read the old format, or add a rehydrate transform, then update this list.",
    ).toEqual(EVENTS_MIGRATIONS_AT_FORMAT_1);
  });

  it("the startup migration writes events in one known place", () => {
    const source = fs.readFileSync(
      path.join(PKG_DIR, "src/migrate.ts"),
      "utf8",
    );
    expect(
      source.match(/\b(INSERT|UPDATE|DELETE)\b[^;`]*\bevents\b/gi),
    ).toHaveLength(1);
  });

  it("every transform version is one rehydrate knows how to apply", () => {
    expect(
      COMPLETED_EVENT_OUTPUT_TRANSFORM_VERSIONS,
      "A transform version changed. Teach rehydrate to apply it to older " +
        "segments (applyPendingTransforms), then update this pin.",
    ).toEqual(REHYDRATE_TRANSFORMS);
  });
});
