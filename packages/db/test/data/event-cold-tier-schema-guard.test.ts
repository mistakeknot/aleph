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


const PKG_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const MIGRATION_DIRS = [
  path.join(PKG_DIR, "drizzle"),
  path.join(PKG_DIR, "drizzle-aleph"),
];
const EVENTS_IDENTIFIER = /(?<![A-Za-z0-9_$])events(?![A-Za-z0-9_$])/gi;

function eventsMentions(text: string): number {
  return text.match(EVENTS_IDENTIFIER)?.length ?? 0;
}

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
  "0114_public_iron_lad",
  "0116_majestic_swordsman",
  "0125_silent_guardian",
];

const REHYDRATE_TRANSFORMS = {
  completedEventOutputSidecar: 1,
  legacyImageGenerationOutputSidecar: 1,
};

function eventsMigrations(): string[] {
  return MIGRATION_DIRS.flatMap((dir) =>
    fs
      .readdirSync(dir)
      .filter((name) => name.endsWith(".sql"))
      .filter(
        (name) =>
          eventsMentions(fs.readFileSync(path.join(dir, name), "utf8")) > 0,
      )
      .map((name) => name.replace(/\.sql$/, "")),
  ).sort();
}

const MIGRATE_TS_EVENTS_MENTIONS = 2;

describe("cold segment schema compatibility", () => {
  it("the events scanner sees writes however they are spelled", () => {
    for (const sql of [
      "UPDATE OR IGNORE events SET type = 'new' WHERE type = 'old';",
      "UPDATE main.events SET data = '{}';",
      "UPDATE /* normalize payloads */ events SET data = '{}';",
      'UPDATE "events" SET data = \'{}\';',
      "UPDATE [events] SET data = '{}';",
      "DELETE FROM`events`;",
      "INSERT INTO\nevents (id) VALUES ('x');",
    ])
      expect(eventsMentions(sql), sql).toBeGreaterThan(0);
    expect(
      eventsMentions(
        "CREATE TABLE thread_events_x (id text); SELECT * FROM my_events;",
      ),
    ).toBe(0);
    expect(eventsMentions("const a = 1;\n`UPDATE events SET x = 1`")).toBe(1);
  });

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

  it("the startup migration mentions events only in known places", () => {
    const source = fs.readFileSync(
      path.join(PKG_DIR, "src/migrate.ts"),
      "utf8",
    );
    expect(
      eventsMentions(source),
      "src/migrate.ts mentions the events table in a new place. If it writes " +
        "events, decide how old cold segments get the change, then update this count.",
    ).toBe(MIGRATE_TS_EVENTS_MENTIONS);
  });

  it("every transform version is one rehydrate knows how to apply", () => {
    expect(
      COMPLETED_EVENT_OUTPUT_TRANSFORM_VERSIONS,
      "A transform version changed. Teach rehydrate to apply it to older " +
        "segments (applyPendingTransforms), then update this pin.",
    ).toEqual(REHYDRATE_TRANSFORMS);
  });
});
