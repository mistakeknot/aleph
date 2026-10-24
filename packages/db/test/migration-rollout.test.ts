import { spawn, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { PERSONAL_PROJECT_ID } from "@bb/domain";
import {
  claimQueuedThreadMessage,
  createConnection,
  createThread,
  migrate,
  noopNotifier,
  releaseQueuedMessageClaim,
  type DbConnection,
} from "../src/index.js";
import { migrateWithFolders } from "../src/migrate.js";
import { acquireMigratingLock } from "../src/migration-lock.js";
import { MigrationStateUnknown } from "../src/migration-ledger.js";
import { alephFolderWithSyntheticStep } from "./helpers/aleph-step-folder.js";
import { applyPrefix } from "./helpers/legacy-oracle.js";
import {
  contentOnly,
  describeDatabase,
  diffDescriptions,
} from "./helpers/migration-equality.js";
import {
  RELEASE_PREFIX_LENGTHS,
  legacyMigrate,
  populatedPrefixDatabase,
  populatedUpstreamDatabase,
} from "./helpers/migration-scenarios.js";
import { sourceFolders } from "./helpers/plan-apply.js";
import { populateDatabase } from "./helpers/populate.js";

const TIMEOUT = 300_000;
const here = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(here, "..");
const childScript = join(here, "helpers", "migrate-child.ts");

const tempDirs: string[] = [];
const openDatabases: DbConnection[] = [];

const liveChildren = new Set<{ child: ChildProcess; closed: Promise<void> }>();

afterEach(async () => {
  for (const { child } of liveChildren) child.kill("SIGKILL");
  await Promise.all([...liveChildren].map((entry) => entry.closed));
  liveChildren.clear();
  for (const db of openDatabases.splice(0)) {
    if (db.$client.open) db.$client.close();
  }
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), "bb-rollout-"));
  tempDirs.push(directory);
  return directory;
}

function track(db: DbConnection): DbConnection {
  openDatabases.push(db);
  return db;
}

function describeFile(path: string) {
  const raw = new Database(path, { readonly: true });
  try {
    return describeDatabase(raw);
  } finally {
    raw.close();
  }
}

const NORMALIZED_TABLES = new Set([
  "__bb_migration_ledger",
  "app_settings_values",
]);

function strictDiff(
  expected: ReturnType<typeof describeDatabase>,
  actual: ReturnType<typeof describeDatabase>,
): string[] {
  return diffDescriptions(contentOnly(expected), contentOnly(actual));
}

function settledRows(sqlite: Database.Database): unknown {
  return {
    ledger: sqlite
      .prepare(
        "SELECT namespace, tag, sha256, how FROM __bb_migration_ledger ORDER BY namespace, tag",
      )
      .all(),
    settings: (
      sqlite
        .prepare("SELECT key, value FROM app_settings_values ORDER BY key")
        .all() as Array<{ key: string; value: string }>
    ).map((row) =>
      row.key === "onboardingCompletedAt"
        ? {
            key: row.key,
            value: Number.isNaN(Date.parse(JSON.parse(row.value) as string))
              ? row.value
              : "<iso timestamp>",
          }
        : row,
    ),
  };
}

function settledRowDifferences(
  expected: Database.Database,
  actual: Database.Database,
): string {
  const left = settledRows(expected) as Record<string, unknown[]>;
  const right = settledRows(actual) as Record<string, unknown[]>;
  const lines: string[] = [];
  for (const key of Object.keys(left)) {
    const l = new Set((left[key] ?? []).map((row) => JSON.stringify(row)));
    const r = new Set((right[key] ?? []).map((row) => JSON.stringify(row)));
    for (const row of l)
      if (!r.has(row)) lines.push(`${key} only expected ${row}`);
    for (const row of r)
      if (!l.has(row)) lines.push(`${key} only actual ${row}`);
  }
  return lines.join(" | ");
}

function settledDiff(expected: Database.Database, actual: Database.Database) {
  const differences = diffDescriptions(
    contentOnly(describeDatabase(expected)),
    contentOnly(describeDatabase(actual)),
  ).filter(
    (line) =>
      ![...NORMALIZED_TABLES].some((name) =>
        line.startsWith(`table differs: ${name} (`),
      ),
  );
  if (
    JSON.stringify(settledRows(expected)) !==
    JSON.stringify(settledRows(actual))
  )
    differences.push(
      `ledger or settings rows differ beyond timestamps: ${settledRowDifferences(expected, actual)}`,
    );
  return differences;
}

function fileSettledDiff(expectedPath: string, actualPath: string): string[] {
  const expected = new Database(expectedPath, { readonly: true });
  const actual = new Database(actualPath, { readonly: true });
  try {
    return settledDiff(expected, actual);
  } finally {
    expected.close();
    actual.close();
  }
}

function foreignKeyViolations(db: DbConnection): string[] {
  const counts = new Map<string, number>();
  for (const row of db.$client.pragma("foreign_key_check") as Array<{
    table: string;
    parent: string;
    fkid: number;
  }>) {
    const key = `${row.table}|${row.parent}|${row.fkid}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts].map(([key, n]) => `${key}=${n}`).sort();
}

function backupsOf(path: string): string[] {
  return readdirSync(dirname(path)).filter(
    (entry) => entry.includes(".pre-ns-") && !entry.endsWith(".sidecar.json"),
  );
}

function populatedFileDatabase(length: number): string {
  const path = join(tempDir(), "bb.db");
  const raw = new Database(path);
  applyPrefix(raw, length);
  const { failed } = populateDatabase(raw);
  if (Object.keys(failed).length > 0)
    throw new Error(`Populate failed: ${JSON.stringify(failed)}`);
  raw.pragma("wal_checkpoint(TRUNCATE)");
  raw.close();
  return path;
}

interface ChildResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

interface StartedChild {
  child: ChildProcess;
  result: Promise<ChildResult>;
  closed: Promise<void>;
}

function startChild(
  path: string,
  point: string,
  extraEnv: Record<string, string> = {},
  alephFolder = sourceFolders.alephFolder,
): StartedChild {
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      childScript,
      path,
      point,
      sourceFolders.upstreamFolder,
      alephFolder,
    ],
    {
      cwd: packageDir,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...extraEnv },
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, TIMEOUT - 30_000);
  let markClosed: () => void = () => undefined;
  const closed = new Promise<void>((resolveClosed) => {
    markClosed = resolveClosed;
  });
  const result = new Promise<ChildResult>((resolveChild, reject) => {
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      markClosed();
      if (timedOut) reject(new Error(`Child timed out: ${stderr}`));
      else resolveChild({ code, signal, stdout, stderr });
    });
  });
  result.catch(() => undefined);
  liveChildren.add({ child, closed });
  return { child, result, closed };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 600; attempt++) {
    if (existsSync(path)) return;
    await delay(50);
  }
  throw new Error(`Timed out waiting for ${path}`);
}

function insertMessage(
  db: DbConnection,
  threadId: string,
  id: string,
  extra: {
    forwardSourceRowId?: string;
    claimedAt?: number;
    claimToken?: string;
    originId?: string;
  } = {},
): void {
  db.$client
    .prepare(
      `INSERT INTO queued_thread_messages (
        id, thread_id, state, content, model, reasoning_level, permission_mode,
        service_tier, group_with_next, forward_source_row_id, claimed_at,
        claim_token, origin_id, sort_key, created_at, updated_at
      ) VALUES (
        @id, @threadId, @state, '[]', 'gpt-5', 'medium', 'full', 'default', 0,
        @forwardSourceRowId, @claimedAt, @claimToken, @originId, @id, 1000, 1000
      )`,
    )
    .run({
      id,
      threadId,
      state: extra.claimedAt === undefined ? "queued" : "claimed",
      forwardSourceRowId: null,
      claimedAt: null,
      claimToken: null,
      originId: null,
      ...extra,
    });
}

function messageIds(db: DbConnection): string[] {
  return (
    db.$client
      .prepare("SELECT id FROM queued_thread_messages ORDER BY id")
      .all() as Array<{ id: string }>
  ).map((row) => row.id);
}

function newThread(db: DbConnection): string {
  return createThread(db, noopNotifier, {
    projectId: PERSONAL_PROJECT_ID,
    providerId: "test-provider",
    status: "idle",
  }).id;
}

interface Upgraded {
  db: DbConnection;
  first: string;
  second: string;
}

function upgradedDatabase(length: number): Upgraded {
  const db = track(createConnection(":memory:"));
  applyPrefix(db.$client, length);
  migrate(db);
  return { db, first: newThread(db), second: newThread(db) };
}

function outcome(action: () => void): string | null {
  try {
    action();
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function seedPendingSlotEntry(upgraded: Upgraded, sourceRowId: string): void {
  upgraded.db.$client
    .prepare(
      "INSERT INTO transfer_operations (id, project_id, operation_key, request_hash, kind, source_thread_id, target_thread_id, state, created_at) VALUES ('op', ?, 'key', 'hash', 'retire', ?, ?, 'active', 1)",
    )
    .run(PERSONAL_PROJECT_ID, upgraded.first, upgraded.second);
  upgraded.db.$client
    .prepare(
      "INSERT INTO transfer_entries (id, op_id, kind, origin_id, source_row_id, state, updated_at) VALUES ('entry', 'op', 'slot', ?, ?, 'pending', 1)",
    )
    .run(sourceRowId, sourceRowId);
}

function entryState(db: DbConnection): unknown {
  return db.$client
    .prepare("SELECT state, detail FROM transfer_entries WHERE id = 'entry'")
    .get();
}

function rowSummary(db: DbConnection): unknown {
  return db.$client
    .prepare(
      "SELECT id, state, claimed_at IS NOT NULL AS claimed, claim_token, forward_source_row_id AS forwardSource, origin_id AS origin FROM queued_thread_messages ORDER BY id",
    )
    .all();
}

function seedSourceWithSlot(upgraded: Upgraded): void {
  insertMessage(upgraded.db, upgraded.first, "src");
  insertMessage(upgraded.db, upgraded.second, "slot", {
    forwardSourceRowId: "src",
    claimedAt: 1,
    claimToken: "slot:one",
  });
  seedPendingSlotEntry(upgraded, "src");
}

interface TriggerScenario {
  name: string;
  dropped: string;
  run: (upgraded: Upgraded) => unknown;
  expected: unknown;
}

const triggerScenarios: TriggerScenario[] = [
  {
    name: "qtm_mint_origin mints the origin id of a new row",
    dropped: "DROP TRIGGER qtm_mint_origin",
    run: ({ db, first }) => {
      insertMessage(db, first, "src");
      return rowSummary(db);
    },
    expected: [
      {
        id: "src",
        state: "queued",
        claimed: 0,
        claim_token: null,
        forwardSource: null,
        origin: "src",
      },
    ],
  },
  {
    name: "qtm_slot_shape_ins refuses a slot with a foreign claim token on insert",
    dropped: "DROP TRIGGER qtm_slot_shape_ins",
    run: ({ db, first, second }) => {
      insertMessage(db, first, "src");
      return outcome(() =>
        insertMessage(db, second, "slot", {
          forwardSourceRowId: "src",
          claimedAt: 1,
          claimToken: "plain",
          originId: "slot",
        }),
      );
    },
    expected: expect.stringContaining("qtm_slot_shape"),
  },
  {
    name: "qtm_slot_shape_upd refuses a slot rewritten to a foreign claim token",
    dropped: "DROP TRIGGER qtm_slot_shape_upd",
    run: ({ db, first, second }) => {
      insertMessage(db, first, "src");
      insertMessage(db, second, "slot", {
        forwardSourceRowId: "src",
        claimedAt: 1,
        claimToken: "slot:one",
      });
      return outcome(() =>
        db.$client
          .prepare(
            "UPDATE queued_thread_messages SET claim_token = 'plain' WHERE id = 'slot'",
          )
          .run(),
      );
    },
    expected: expect.stringContaining("qtm_slot_shape"),
  },
  {
    name: "qtm_one_slot_per_source refuses a second slot for one source",
    dropped: "DROP INDEX qtm_one_slot_per_source",
    run: ({ db, first, second }) => {
      insertMessage(db, first, "src");
      insertMessage(db, second, "slot", {
        forwardSourceRowId: "src",
        claimedAt: 1,
        claimToken: "slot:one",
      });
      return outcome(() =>
        insertMessage(db, second, "slot-two", {
          forwardSourceRowId: "src",
          claimedAt: 1,
          claimToken: "slot:two",
        }),
      );
    },
    expected: expect.stringContaining("UNIQUE constraint failed"),
  },
  {
    name: "qtm_one_live_copy refuses a second live copy of one origin",
    dropped: "DROP INDEX qtm_one_live_copy",
    run: ({ db, first, second }) => {
      insertMessage(db, first, "src");
      return outcome(() =>
        insertMessage(db, second, "copy", { originId: "src" }),
      );
    },
    expected: expect.stringContaining("UNIQUE constraint failed"),
  },
  {
    name: "qtm_t1_claim_exit turns a slot into a requeued fill and forwards its entry when the source claim is released",
    dropped: "DROP TRIGGER qtm_t1_claim_exit",
    run: (upgraded) => {
      const { db, first } = upgraded;
      insertMessage(db, first, "src");
      const claimed = claimQueuedThreadMessage(db, noopNotifier, "src");
      expect(claimed?.state).toBe("claimed");
      insertMessage(db, upgraded.second, "slot", {
        forwardSourceRowId: "src",
        claimedAt: 1,
        claimToken: "slot:one",
      });
      seedPendingSlotEntry(upgraded, "src");
      expect(
        releaseQueuedMessageClaim(db, noopNotifier, {
          id: "src",
          claimToken: claimed!.claimToken,
        }),
      ).toBe(true);
      return { rows: rowSummary(db), entry: entryState(db) };
    },
    expected: {
      rows: [
        {
          id: "slot",
          state: "queued",
          claimed: 0,
          claim_token: null,
          forwardSource: null,
          origin: "slot",
        },
      ],
      entry: { state: "forwarded", detail: null },
    },
  },
  {
    name: "qtm_t2_slot_deleted resolves the entry and removes the source when a slot is deleted",
    dropped: "DROP TRIGGER qtm_t2_slot_deleted",
    run: (upgraded) => {
      seedSourceWithSlot(upgraded);
      upgraded.db.$client
        .prepare("DELETE FROM queued_thread_messages WHERE id = 'slot'")
        .run();
      return { rows: rowSummary(upgraded.db), entry: entryState(upgraded.db) };
    },
    expected: { rows: [], entry: { state: "target_deleted", detail: null } },
  },
  {
    name: "qtm_t3_source_deleted removes the slot of a deleted source",
    dropped: "DROP TRIGGER qtm_t3_source_deleted",
    run: (upgraded) => {
      seedSourceWithSlot(upgraded);
      upgraded.db.$client
        .prepare("DELETE FROM queued_thread_messages WHERE id = 'src'")
        .run();
      return { rows: rowSummary(upgraded.db), entry: entryState(upgraded.db) };
    },
    expected: { rows: [], entry: { state: "left_source", detail: null } },
  },
  {
    name: "threads_soft_deleted removes the slots of a soft-deleted thread",
    dropped: "DROP TRIGGER threads_soft_deleted",
    run: (upgraded) => {
      seedSourceWithSlot(upgraded);
      upgraded.db.$client
        .prepare("UPDATE threads SET deleted_at = 5 WHERE id = ?")
        .run(upgraded.second);
      return { rows: rowSummary(upgraded.db), entry: entryState(upgraded.db) };
    },
    expected: { rows: [], entry: { state: "target_deleted", detail: null } },
  },
];

describe("triggers after an upgrade", () => {
  describe.each([131, 146, 153])("from prefix %i", (length) => {
    it.each(triggerScenarios)("$name", (scenario) => {
      expect(scenario.run(upgradedDatabase(length))).toEqual(scenario.expected);
    });
  });

  it.each(triggerScenarios)(
    "$name, and the scenario fails without it",
    (scenario) => {
      const upgraded = upgradedDatabase(153);
      upgraded.db.$client.exec(scenario.dropped);
      expect(scenario.run(upgraded)).not.toEqual(scenario.expected);
    },
  );
});

describe("the previous runner opens a migrated database", () => {
  it.each(RELEASE_PREFIX_LENGTHS)(
    "leaves the schema, data and compatibility log alone from prefix %i",
    async (length) => {
      const db = track(await populatedPrefixDatabase(length));
      migrate(db);
      const before = describeDatabase(db.$client);
      const settledBefore = settledRows(db.$client);
      const compatBefore = db.$client
        .prepare(
          "SELECT hash, created_at FROM __drizzle_migrations ORDER BY rowid",
        )
        .all();

      await legacyMigrate(db);

      expect(strictDiff(before, describeDatabase(db.$client))).toEqual([]);
      expect(settledRows(db.$client)).toEqual(settledBefore);
      expect(
        db.$client
          .prepare(
            "SELECT hash, created_at FROM __drizzle_migrations ORDER BY rowid",
          )
          .all(),
      ).toEqual(compatBefore);
    },
    TIMEOUT,
  );

  it("leaves a fresh database migrated by the new runner alone", async () => {
    const db = track(createConnection(":memory:"));
    migrate(db);
    const before = describeDatabase(db.$client);
    const settledBefore = settledRows(db.$client);

    await legacyMigrate(db);

    expect(strictDiff(before, describeDatabase(db.$client))).toEqual([]);
    expect(settledRows(db.$client)).toEqual(settledBefore);
  });

  it("still serves the previous release's statements on the result", async () => {
    const db = track(await populatedPrefixDatabase(153));
    migrate(db);
    const violations = foreignKeyViolations(db);
    const eventCount = (): number =>
      (
        db.$client.prepare("SELECT count(*) AS n FROM events").get() as {
          n: number;
        }
      ).n;
    const eventsBefore = eventCount();
    expect(eventsBefore).toBeGreaterThan(0);

    await legacyMigrate(db);

    expect(eventCount()).toBe(eventsBefore);
    const thread = newThread(db);
    insertMessage(db, thread, "from-old-binary");
    const claimed = claimQueuedThreadMessage(
      db,
      noopNotifier,
      "from-old-binary",
    );
    expect(claimed).toMatchObject({ id: "from-old-binary", state: "claimed" });
    expect(
      db.$client
        .prepare(
          "SELECT state, claimed_at IS NOT NULL AS claimed FROM queued_thread_messages WHERE id = 'from-old-binary'",
        )
        .get(),
    ).toEqual({ state: "claimed", claimed: 1 });
    db.$client
      .prepare("UPDATE threads SET deleted_at = 9 WHERE id = ?")
      .run(thread);
    expect(messageIds(db)).toContain("from-old-binary");
    expect(foreignKeyViolations(db)).toEqual(violations);
  });
});

describe("downgrade honesty", () => {
  it("lets the previous runner open a database that has one genuinely new step and keeps the new table", async () => {
    const db = track(await populatedPrefixDatabase(153));
    migrate(db);
    const alephFolder = alephFolderWithSyntheticStep(
      "CREATE TABLE zz_after_release (id TEXT PRIMARY KEY);",
      { createsTables: ["zz_after_release"] },
    );
    tempDirs.push(alephFolder);
    migrateWithFolders(db, {
      upstreamFolder: sourceFolders.upstreamFolder,
      alephFolder,
    });
    const compatBefore = db.$client
      .prepare("SELECT hash, created_at FROM __drizzle_migrations")
      .all();

    await legacyMigrate(db);

    expect(
      db.$client
        .prepare("SELECT 1 AS present FROM sqlite_master WHERE name = ?")
        .get("zz_after_release"),
    ).toEqual({ present: 1 });
    expect(
      db.$client
        .prepare("SELECT hash, created_at FROM __drizzle_migrations")
        .all(),
    ).toEqual(compatBefore);
  });
});

function connectChildren(raw: Database.Database): string[] {
  const threadIds = (
    raw.prepare("SELECT id FROM threads ORDER BY rowid").all() as Array<{
      id: string;
    }>
  ).map((row) => row.id);
  const tables = (
    raw
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as Array<{ name: string }>
  ).map((row) => row.name);
  const connected: string[] = [];
  for (const name of tables) {
    const edges = (
      raw.pragma(`foreign_key_list(${JSON.stringify(name)})`) as Array<{
        table: string;
        from: string;
      }>
    ).filter(
      (edge) =>
        edge.table === "threads" &&
        name !== "threads" &&
        name !== "thread_pruning_cursors",
    );
    edges.forEach((edge, edgeIndex) => {
      const rowids = (
        raw
          .prepare(`SELECT rowid FROM ${JSON.stringify(name)} ORDER BY rowid`)
          .all() as Array<{ rowid: number }>
      ).map((row) => row.rowid);
      rowids.forEach((rowid, index) => {
        raw
          .prepare(
            `UPDATE ${JSON.stringify(name)} SET ${JSON.stringify(edge.from)} = ? WHERE rowid = ?`,
          )
          .run(threadIds[(index + edgeIndex) % threadIds.length], rowid);
      });
      connected.push(`${name}.${edge.from}`);
    });
  }
  return connected;
}

type ChildRows = Record<string, Array<Record<string, unknown>>>;

function childRows(raw: Database.Database, columns: string[]): ChildRows {
  const rows: ChildRows = {};
  for (const column of columns) {
    const [table, from] = column.split(".");
    rows[column] = raw
      .prepare(
        `SELECT c.* FROM ${JSON.stringify(table)} AS c JOIN threads AS p ON p.id = c.${JSON.stringify(from)}`,
      )
      .all() as Array<Record<string, unknown>>;
  }
  return rows;
}

function survivingChildRows(before: ChildRows, after: ChildRows): string[][] {
  return [before, after].map((rows) =>
    Object.keys(before).flatMap((column) => {
      const kept = Object.keys(before[column]?.[0] ?? {}).filter((name) =>
        (after[column] ?? []).every((row) => name in row),
      );
      return (rows[column] ?? [])
        .map((row) =>
          JSON.stringify([column, kept.map((name) => [name, row[name]])]),
        )
        .sort();
    }),
  );
}

describe("foreign keys stay enforced across the upgrade", () => {
  it.each([131, 153])(
    "keeps every connected row that references threads from prefix %i",
    async (length) => {
      const db = track(await populatedPrefixDatabase(length));
      const columns = connectChildren(db.$client);
      expect(columns.length).toBeGreaterThan(10);
      db.$client.pragma("foreign_keys = ON");
      const rowsBefore = childRows(db.$client, columns);
      for (const column of columns) expect(rowsBefore[column]).not.toEqual([]);
      const threadsBefore = db.$client
        .prepare("SELECT id FROM threads ORDER BY id")
        .all();
      const violations = foreignKeyViolations(db);

      migrate(db);

      expect(db.$client.pragma("foreign_keys", { simple: true })).toBe(1);
      expect(
        db.$client.prepare("SELECT id FROM threads ORDER BY id").all(),
      ).toEqual(threadsBefore);
      const rowsAfter = childRows(db.$client, columns);
      const [projectedBefore, projectedAfter] = survivingChildRows(
        rowsBefore,
        rowsAfter,
      );
      expect(projectedAfter).toEqual(projectedBefore);
      expect(foreignKeyViolations(db)).toEqual(violations);
    },
    TIMEOUT,
  );

  it(
    "rolls back a step that leaves a new foreign key violation and keeps the database intact",
    async () => {
      const db = track(await populatedPrefixDatabase(153));
      migrate(db);
      const before = describeDatabase(db.$client);
      const settledBefore = settledRows(db.$client);
      const alephFolder = alephFolderWithSyntheticStep(
        "UPDATE prompt_history_entries SET thread_id = 'zz-missing-thread';",
        { writesTables: ["prompt_history_entries"] },
      );
      tempDirs.push(alephFolder);

      expect(() =>
        migrateWithFolders(db, {
          upstreamFolder: sourceFolders.upstreamFolder,
          alephFolder,
        }),
      ).toThrow(/new foreign key violations/);

      expect(strictDiff(before, describeDatabase(db.$client))).toEqual([]);
      expect(settledRows(db.$client)).toEqual(settledBefore);
      expect(db.$client.pragma("foreign_keys", { simple: true })).toBe(1);
      expect(
        db.$client
          .prepare(
            "SELECT count(*) AS n FROM prompt_history_entries WHERE thread_id = 'zz-missing-thread'",
          )
          .get(),
      ).toEqual({ n: 0 });
    },
    TIMEOUT,
  );
});

describe("a migration killed in another process", () => {
  it(
    "rolls back a kill in the middle of the transaction and then completes",
    async () => {
      const path = populatedFileDatabase(131);
      const before = describeFile(path);
      const reference = join(tempDir(), "bb.db");
      cpSync(path, reference);
      const referenceDb = track(createConnection(reference));
      migrate(referenceDb);

      const marker = join(tempDir(), "died");
      const killed = await startChild(path, "mid-transaction", {
        BB_DIE_MARKER: marker,
      }).result;
      expect(killed.signal).toBe("SIGKILL");
      expect(existsSync(marker)).toBe(true);
      expect(killed.stdout).not.toContain("migrated");

      expect(strictDiff(before, describeFile(path))).toEqual([]);

      const db = track(createConnection(path));
      migrate(db);
      expect(settledDiff(referenceDb.$client, db.$client)).toEqual([]);
      expect(db.$client.pragma("integrity_check", { simple: true })).toBe("ok");
      expect(foreignKeyViolations(db)).toEqual(
        foreignKeyViolations(referenceDb),
      );
    },
    TIMEOUT,
  );

  it(
    "keeps a committed migration when the process dies after the backup is finalized",
    async () => {
      const path = populatedFileDatabase(131);
      const reference = join(tempDir(), "bb.db");
      cpSync(path, reference);
      const referenceDb = track(createConnection(reference));
      migrate(referenceDb);

      const marker = join(tempDir(), "died");
      const killed = await startChild(path, "after-backup-finalized", {
        BB_DIE_MARKER: marker,
      }).result;
      expect(killed.signal).toBe("SIGKILL");
      expect(existsSync(marker)).toBe(true);

      const db = track(createConnection(path));
      const reports: unknown[] = [];
      migrate(db, { onBackup: (report) => reports.push(report) });
      expect(reports).toEqual([]);
      expect(settledDiff(referenceDb.$client, db.$client)).toEqual([]);
      expect(backupsOf(path)).toHaveLength(1);
    },
    TIMEOUT,
  );

  it(
    "blocks two contending processes behind a held migration lock, then lets one win with one backup",
    async () => {
      const path = populatedFileDatabase(131);
      const reference = join(tempDir(), "bb.db");
      cpSync(path, reference);
      const referenceDb = track(createConnection(reference));
      migrate(referenceDb);
      const before = describeFile(path);
      const barrier = tempDir();

      const holder = new Database(path);
      const lock = acquireMigratingLock(holder);
      expect(lock).not.toBeNull();
      let children: StartedChild[] = [];
      try {
        children = [0, 1].map((index) =>
          startChild(path, "none", {
            BB_READY_FILE: join(barrier, `ready-${index}`),
            BB_BEFORE_MIGRATE_FILE: join(barrier, `go-${index}`),
          }),
        );
        await Promise.all(
          [0, 1].map((index) => waitForFile(join(barrier, `go-${index}`))),
        );
        await delay(2000);
        for (const { child } of children) {
          expect(child.exitCode).toBeNull();
          expect(child.signalCode).toBeNull();
        }
        expect(backupsOf(path)).toHaveLength(0);
        expect(strictDiff(before, describeFile(path))).toEqual([]);
      } finally {
        lock?.release();
        holder.close();
      }

      const results = await Promise.all(children.map((entry) => entry.result));
      for (const result of results) {
        expect(result.stderr).toBe("");
        expect(result.code).toBe(0);
        expect(result.stdout).toContain("migrated");
      }

      expect(fileSettledDiff(reference, path)).toEqual([]);
      expect(backupsOf(path)).toHaveLength(1);
    },
    TIMEOUT,
  );
});

describe("ledger shapes the classifier refuses before any step runs (D14: S3 rows 18-20 fixtures; D15: S3 row 21)", () => {
  function expectRefusedUnchanged(db: DbConnection): void {
    const before = describeDatabase(db.$client);
    let thrown: unknown;
    try {
      migrate(db);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(MigrationStateUnknown);
    expect(describeDatabase(db.$client)).toEqual(before);
  }

  it("refuses an unknown past row on a full legacy ledger", async () => {
    const db = track(await populatedPrefixDatabase(153));
    db.$client
      .prepare(
        "INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)",
      )
      .run("unknown-past-step", 1);
    expectRefusedUnchanged(db);
  });

  it("refuses an unknown future row on a full legacy ledger", async () => {
    const db = track(await populatedPrefixDatabase(153));
    db.$client
      .prepare(
        "INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)",
      )
      .run("unknown-future-step", Date.now() + 86_400_000);
    expectRefusedUnchanged(db);
  });

  it("refuses a junk hash at the created_at of a canonical step", async () => {
    const db = track(await populatedPrefixDatabase(153));
    db.$client.exec(
      "INSERT INTO __drizzle_migrations (hash, created_at) SELECT 'junk-hash', created_at FROM __drizzle_migrations WHERE rowid = 70",
    );
    expectRefusedUnchanged(db);
  });

  it("refuses a ledger whose every created_at is NULL", async () => {
    const db = track(await populatedPrefixDatabase(153));
    db.$client.exec("UPDATE __drizzle_migrations SET created_at = NULL");
    expectRefusedUnchanged(db);
  });

  it("refuses a ledger written by upstream bb with 0143 recorded and no A0009", async () => {
    const db = track(await populatedUpstreamDatabase());
    expectRefusedUnchanged(db);
  });
});
