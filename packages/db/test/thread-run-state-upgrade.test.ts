import { createThread, noopNotifier } from "../src/index.js";
import { PERSONAL_PROJECT_ID } from "@bb/domain";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createConnection } from "../src/connection.js";
import { migrate, migrateWithFolders } from "../src/migrate.js";
import { loadMigrationPlan } from "../src/migration-plan.js";
import { sourceFolders } from "./helpers/plan-apply.js";

function expectRunStateTables(db: ReturnType<typeof createConnection>) {
  expect(
    db.$client
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('thread_run_states', 'thread_turn_requests') ORDER BY name",
      )
      .all(),
  ).toEqual([{ name: "thread_run_states" }, { name: "thread_turn_requests" }]);
  expect(db.$client.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
}

describe("upstream 0157 lifecycle migration", () => {
  it("fresh install includes both lifecycle tables and is idempotent", () => {
    const db = createConnection(":memory:");
    try {
      migrate(db);
      expectRunStateTables(db);
      migrate(db);
      expectRunStateTables(db);
    } finally {
      db.$client.close();
    }
  });

  it("upgrades 0156 plus A0015 and A0016 to 0157 without reordering or rewriting prior data", () => {
    const dir = mkdtempSync(join(tmpdir(), "bb-run-state-upgrade-"));
    const folders = {
      upstreamFolder: join(dir, "upstream"),
      alephFolder: join(dir, "aleph"),
    };
    cpSync(sourceFolders.upstreamFolder, folders.upstreamFolder, {
      recursive: true,
    });
    cpSync(sourceFolders.alephFolder, folders.alephFolder, { recursive: true });
    const journalPath = join(folders.upstreamFolder, "meta/_journal.json");
    const journal = JSON.parse(readFileSync(journalPath, "utf8"));
    journal.entries = journal.entries.filter(
      (step: { tag: string }) => step.tag !== "0157_thread_run_state",
    );
    writeFileSync(journalPath, JSON.stringify(journal));
    const frozenPath = join(folders.alephFolder, "frozen-upstream.json");
    const frozen = JSON.parse(readFileSync(frozenPath, "utf8"));
    frozen.steps = frozen.steps.filter(
      (step: { tag: string }) => step.tag !== "0157_thread_run_state",
    );
    writeFileSync(frozenPath, JSON.stringify(frozen));
    const db = createConnection(join(dir, "upgrade.db"));
    try {
      migrateWithFolders(db, folders);
      expect(
        loadMigrationPlan(folders)
          .steps.slice(-3)
          .map((step) => step.id),
      ).toEqual(["0156_plugin_failure_labels", "A0015", "A0016"]);
      expect(
        db.$client
          .prepare(
            "SELECT name FROM sqlite_master WHERE name IN ('thread_run_states', 'thread_turn_requests')",
          )
          .all(),
      ).toEqual([]);
      createThread(db, noopNotifier, {
        projectId: PERSONAL_PROJECT_ID,
        providerId: "test-provider",
        status: "idle",
        title: "Preserved upgrade row",
      });
      const threads = db.$client
        .prepare("SELECT * FROM threads ORDER BY id")
        .all();
      const ledger = db.$client
        .prepare("SELECT * FROM __bb_migration_ledger ORDER BY namespace, tag")
        .all();
      migrate(db);
      expect(
        loadMigrationPlan(sourceFolders)
          .steps.slice(-4)
          .map((step) => step.id),
      ).toEqual([
        "0156_plugin_failure_labels",
        "A0015",
        "A0016",
        "0157_thread_run_state",
      ]);
      expectRunStateTables(db);
      expect(
        db.$client.prepare("SELECT * FROM threads ORDER BY id").all(),
      ).toEqual(threads);
      expect(
        db.$client
          .prepare(
            "SELECT * FROM __bb_migration_ledger WHERE tag <> '0157_thread_run_state' ORDER BY namespace, tag",
          )
          .all(),
      ).toEqual(ledger);
      migrate(db);
      expectRunStateTables(db);
    } finally {
      db.$client.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
