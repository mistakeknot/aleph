import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createConnection,
  createEnvironment,
  createProject,
  createThread,
  deleteThread,
  getEventColdSegment,
  getThreadEventColdStateRow,
  insertEvents,
  isThreadEventsCold,
  noopNotifier,
  projectAttachmentBackfills,
  upsertHost,
  type ColdEventRow,
  type DbConnection,
} from "@bb/db";
import { createMigratedConnection } from "@bb/db/testing";
import { extractServerArchive } from "@bb/server-archive";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const exportHooks = vi.hoisted(() => ({
  beforeManifestSnapshot: null as null | (() => Promise<void>),
}));

vi.mock(
  "../../src/services/threads/event-cold-tier/manifest.js",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../../src/services/threads/event-cold-tier/manifest.js")
      >();
    return {
      ...actual,
      snapshotColdManifestPrefix: async (
        ...args: Parameters<typeof actual.snapshotColdManifestPrefix>
      ) => {
        await exportHooks.beforeManifestSnapshot?.();
        return actual.snapshotColdManifestPrefix(...args);
      },
    };
  },
);

const { ColdManifest, readColdManifestEntries } =
  await import("../../src/services/threads/event-cold-tier/manifest.js");
const {
  moveThreadEventsToColdTier,
  reconcileEventColdTier,
  rehydrateThreadEvents,
  setColdTierFaultsForTesting,
} = await import("../../src/services/threads/event-cold-tier/service.js");
const { exportServerArchive } =
  await import("../../src/services/server-move/export.js");
type EventColdTierDeps =
  import("../../src/services/threads/event-cold-tier/service.js").EventColdTierDeps;
type EventColdTierConfig =
  import("../../src/services/threads/event-cold-tier/config.js").EventColdTierConfig;

const DAY_MS = 24 * 60 * 60_000;
const NOW = 100 * DAY_MS;
const LARGE_OUTPUT_CHARS = 40 * 1024;

const CONFIG: EventColdTierConfig = {
  maxThreadBytes: 32 * 1024 * 1024,
  maxThreadBytesClamped: false,
  minArchivedMs: 14 * DAY_MS,
  mode: "on",
  rehotCooldownMs: 7 * DAY_MS,
};

let root: string;
const open: DbConnection[] = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "bb-cold-restart-"));
});

afterEach(async () => {
  exportHooks.beforeManifestSnapshot = null;
  vi.restoreAllMocks();
  for (const db of open.splice(0)) {
    if (db.$client.open) db.$client.close();
  }
  await rm(root, { force: true, recursive: true });
});

function openDb(path: string): DbConnection {
  const db = createConnection(path) as DbConnection;
  open.push(db);
  return db;
}

function closeDb(db: DbConnection): void {
  db.$client.close();
}

function makeDeps(db: DbConnection, dataDir: string): EventColdTierDeps {
  return {
    config: { dataDir },
    db,
    hub: { notifyThread: vi.fn() },
    logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
  } as unknown as EventColdTierDeps;
}

async function persistedDatabase(dataDir: string): Promise<string> {
  const path = join(dataDir, "bb.db");
  await writeFile(path, createMigratedConnection().$client.serialize());
  return path;
}

function seedColdThread(db: DbConnection, label: string): string {
  const host = upsertHost(db, noopNotifier, { name: `host-${label}` });
  const { project } = createProject(db, noopNotifier, {
    name: `project-${label}`,
    source: { type: "local_path", hostId: host.id, path: `/tmp/${label}` },
  });
  const environment = createEnvironment(db, noopNotifier, {
    projectId: project.id,
    hostId: host.id,
    path: `/tmp/${label}/environment`,
    providerOwnsPath: false,
    status: "ready",
    environmentProvider: null,
  });
  const thread = createThread(db, noopNotifier, {
    projectId: project.id,
    providerId: "codex",
    environmentId: environment.id,
    status: "idle",
  });
  insertEvents(db, noopNotifier, [
    {
      threadId: thread.id,
      scope: { kind: "thread" },
      sequence: 1,
      type: "thread/identity",
      itemId: null,
      itemKind: null,
      parentToolCallId: null,
      createdAt: 1,
      data: JSON.stringify({ name: label }),
    },
    ...Array.from({ length: 40 }, (_, index) => ({
      threadId: thread.id,
      scope: { kind: "turn" as const, turnId: "turn-1" },
      sequence: index + 2,
      type: "turn/diff/updated" as const,
      itemId: null,
      itemKind: null,
      parentToolCallId: null,
      createdAt: index + 2,
      data: JSON.stringify({ diff: `diff ${index} ${"x".repeat(64)}` }),
    })),
  ]);
  db.$client
    .prepare(
      "UPDATE environments SET status = 'destroyed', teardown_status = 'removed', owner_thread_id = NULL WHERE id = ?",
    )
    .run(environment.id);
  db.$client
    .prepare("UPDATE threads SET archived_at = ? WHERE id = ?")
    .run(NOW - 30 * DAY_MS, thread.id);
  db.insert(projectAttachmentBackfills)
    .values({
      projectId: project.id,
      phase: "done",
      threadCursor: "",
      inputCursor: 0,
      inputId: "",
      inputSequence: 0,
      attemptedAt: 0,
      error: null,
    })
    .run();
  db.$client
    .prepare("DELETE FROM thread_pruning_work WHERE thread_id = ?")
    .run(thread.id);
  return thread.id;
}

function readRows(db: DbConnection, threadId: string): ColdEventRow[] {
  return db.$client
    .prepare<[string], ColdEventRow>(
      "SELECT * FROM events WHERE thread_id = ? ORDER BY sequence",
    )
    .all(threadId);
}

function settle(db: DbConnection, threadId: string): void {
  db.$client
    .prepare("DELETE FROM thread_pruning_work WHERE thread_id = ?")
    .run(threadId);
}

async function exportAndRestore(
  db: DbConnection,
  dataDir: string,
): Promise<{ db: DbConnection; dataDir: string }> {
  const archive = await exportServerArchive({
    appVersion: "0.0.0-test",
    dataDir,
    db,
    fileName: "server.tar.gz",
    logger: { warn: vi.fn() },
    now: NOW,
    sourceServerHostId: null,
    workDir: join(root, "export"),
  });
  const destination = join(root, "restored");
  await extractServerArchive({
    archivePath: archive.path,
    destinationDir: destination,
  });
  const restoredDataDir = join(destination, "files");
  return {
    dataDir: restoredDataDir,
    db: openDb(join(restoredDataDir, "bb.db")),
  };
}

describe("cold tier across restarts and restores", () => {
  it("repairs the committed entry after a COMMIT whose append never landed", async () => {
    const dataDir = join(root, "data");
    await mkdir(dataDir, { recursive: true });
    const path = await persistedDatabase(dataDir);
    let db = openDb(path);
    const threadId = seedColdThread(db, "commit-gap");
    const before = readRows(db, threadId);

    const append = ColdManifest.prototype.append;
    vi.spyOn(ColdManifest.prototype, "append").mockImplementation(
      async function (this: InstanceType<typeof ColdManifest>, entry) {
        if (entry.kind === "committed") throw new Error("crash before append");
        return append.call(this, entry);
      },
    );
    await moveThreadEventsToColdTier(makeDeps(db, dataDir), threadId, {
      config: CONFIG,
      now: NOW,
    }).catch(() => undefined);
    vi.restoreAllMocks();
    expect(isThreadEventsCold(db, threadId)).toBe(true);
    const segmentId = getThreadEventColdStateRow(db, threadId)!.liveSegmentId!;
    expect(
      (await readColdManifestEntries(dataDir)).map((entry) => entry.kind),
    ).toEqual(["pending"]);

    closeDb(db);
    db = openDb(path);
    const deps = makeDeps(db, dataDir);
    const reconciled = await reconcileEventColdTier(deps, NOW);
    expect(reconciled.repairedCommitted).toEqual([segmentId]);
    expect(reconciled.classes.referenced.count).toBe(1);
    expect(reconciled.missingLiveSegments).toEqual([]);
    expect(
      (await readColdManifestEntries(dataDir)).map((entry) => entry.kind),
    ).toEqual(["pending", "committed"]);

    expect((await rehydrateThreadEvents(deps, threadId)).outcome).toBe(
      "rehydrated",
    );
    expect(readRows(db, threadId)).toEqual(before);
  });

  it("keeps rows hot after a crash between the pending entry and COMMIT", async () => {
    const dataDir = join(root, "data");
    await mkdir(dataDir, { recursive: true });
    const path = await persistedDatabase(dataDir);
    let db = openDb(path);
    const threadId = seedColdThread(db, "pending-gap");
    const before = readRows(db, threadId);

    const deps = makeDeps(db, dataDir);
    setColdTierFaultsForTesting(deps, {
      afterManifestPending: () => {
        throw new Error("crash after pending");
      },
    });
    await moveThreadEventsToColdTier(deps, threadId, {
      config: CONFIG,
      now: NOW,
    }).catch(() => undefined);

    closeDb(db);
    db = openDb(path);
    expect(isThreadEventsCold(db, threadId)).toBe(false);
    expect(readRows(db, threadId)).toEqual(before);
    const restarted = makeDeps(db, dataDir);
    const reconciled = await reconcileEventColdTier(restarted, NOW);
    expect(reconciled.repairedCommitted).toEqual([]);
    expect(reconciled.classes.uncertain.count).toBe(1);
    expect(reconciled.classes.referenced.count).toBe(0);

    const move = await moveThreadEventsToColdTier(restarted, threadId, {
      config: CONFIG,
      now: NOW,
    });
    expect(move.outcome).toBe("moved");
    expect((await rehydrateThreadEvents(restarted, threadId)).outcome).toBe(
      "rehydrated",
    );
    expect(readRows(db, threadId)).toEqual(before);
  });

  it("restores a thread moved cold twice to its full history", async () => {
    const dataDir = join(root, "data");
    await mkdir(dataDir, { recursive: true });
    const db = openDb(await persistedDatabase(dataDir));
    const threadId = seedColdThread(db, "two-cycles");
    const before = readRows(db, threadId);
    const deps = makeDeps(db, dataDir);

    const first = await moveThreadEventsToColdTier(deps, threadId, {
      config: CONFIG,
      now: NOW,
    });
    expect(first.outcome).toBe("moved");
    await rehydrateThreadEvents(deps, threadId);
    settle(db, threadId);
    const second = await moveThreadEventsToColdTier(deps, threadId, {
      config: CONFIG,
      now: Date.now() + 8 * DAY_MS,
    });
    expect(second.outcome).toBe("moved");
    expect(second.segmentId).not.toBe(first.segmentId);

    const restored = await exportAndRestore(db, dataDir);
    const restoredDeps = makeDeps(restored.db, restored.dataDir);
    const reconciled = await reconcileEventColdTier(restoredDeps, NOW);
    expect(reconciled.classes.referenced.count).toBe(1);
    expect(reconciled.classes.ended.count).toBe(1);
    expect(reconciled.missingLiveSegments).toEqual([]);
    expect(reconciled.inconsistencies).toEqual([]);
    expect((await rehydrateThreadEvents(restoredDeps, threadId)).outcome).toBe(
      "rehydrated",
    );
    expect(readRows(restored.db, threadId)).toEqual(before);
  });

  it("orphans the segment of a hard-deleted cold thread, before and after restore", async () => {
    const dataDir = join(root, "data");
    await mkdir(dataDir, { recursive: true });
    const db = openDb(await persistedDatabase(dataDir));
    const deletedId = seedColdThread(db, "deleted");
    const keptId = seedColdThread(db, "kept");
    const keptBefore = readRows(db, keptId);
    const deps = makeDeps(db, dataDir);
    const deleted = await moveThreadEventsToColdTier(deps, deletedId, {
      config: CONFIG,
      now: NOW,
    });
    await moveThreadEventsToColdTier(deps, keptId, {
      config: CONFIG,
      now: NOW,
    });

    expect(deleteThread(db, noopNotifier, deletedId)).toBe(true);
    const reconciled = await reconcileEventColdTier(deps, NOW);
    expect(reconciled.orphaned).toEqual([deleted.segmentId]);
    expect(getEventColdSegment(db, deleted.segmentId!)?.lifecycle).toBe(
      "orphaned",
    );
    expect(reconciled.missingLiveSegments).toEqual([]);
    expect(reconciled.classes.referenced.count).toBe(1);
    expect(reconciled.classes.ended.count).toBe(1);

    const restored = await exportAndRestore(db, dataDir);
    const restoredDeps = makeDeps(restored.db, restored.dataDir);
    const again = await reconcileEventColdTier(restoredDeps, NOW);
    expect(again.orphaned).toEqual([]);
    expect(again.missingLiveSegments).toEqual([]);
    expect(again.classes.referenced.count).toBe(1);
    expect(again.classes.ended.count).toBe(1);
    expect((await rehydrateThreadEvents(restoredDeps, keptId)).outcome).toBe(
      "rehydrated",
    );
    expect(readRows(restored.db, keptId)).toEqual(keptBefore);
  });

  it("applies transforms newer than the segment when it comes back", async () => {
    const dataDir = join(root, "data");
    await mkdir(dataDir, { recursive: true });
    const path = await persistedDatabase(dataDir);
    let db = openDb(path);
    const threadId = seedColdThread(db, "old-transforms");
    const output = "o".repeat(LARGE_OUTPUT_CHARS);
    db.$client
      .prepare(
        `INSERT INTO events (id, thread_id, scope_kind, turn_id, sequence, type, item_id, item_kind, data, created_at)
         VALUES ('evt-large-output', ?, 'turn', 'turn-1', -1, 'item/completed', 'item-1', 'commandExecution', ?, ?)`,
      )
      .run(
        threadId,
        JSON.stringify({
          item: {
            aggregatedOutput: output,
            id: "item-1",
            type: "commandExecution",
          },
        }),
        Date.now(),
      );
    db.$client
      .prepare(
        `INSERT INTO maintenance_scan_cursors (id, policy, version, item_kind, output_path, last_created_at, last_event_id, updated_at)
         VALUES ('legacy_completed_event_output_sidecar:v1:commandExecution:aggregatedOutput', 'legacy_completed_event_output_sidecar', 1, 'commandExecution', 'aggregatedOutput', -1, '', 0)`,
      )
      .run();
    settle(db, threadId);
    const move = await moveThreadEventsToColdTier(
      makeDeps(db, dataDir),
      threadId,
      { config: CONFIG, now: NOW },
    );
    expect(move).toMatchObject({ outcome: "moved", reason: null });
    expect(
      db.$client
        .prepare(
          "SELECT COUNT(*) AS n FROM events WHERE id = 'evt-large-output'",
        )
        .get(),
    ).toEqual({ n: 0 });
    db.$client
      .prepare(
        "UPDATE event_cold_segments SET transform_versions = '{}' WHERE segment_id = ?",
      )
      .run(move.segmentId);

    closeDb(db);
    db = openDb(path);
    expect(
      (await rehydrateThreadEvents(makeDeps(db, dataDir), threadId)).outcome,
    ).toBe("rehydrated");
    const large = db.$client
      .prepare<[], { data: string }>(
        "SELECT data FROM events WHERE id = 'evt-large-output'",
      )
      .get()!;
    expect(large.data.length).toBeLessThan(LARGE_OUTPUT_CHARS);
    const sidecar = db.$client
      .prepare<[], { output_path: string; value: string }>(
        "SELECT output_path, value FROM retained_event_outputs WHERE event_id = 'evt-large-output'",
      )
      .get();
    expect(sidecar?.output_path).toBe("aggregatedOutput");
    expect(sidecar?.value).toBe(output);
  });

  it("restores consistently when a move lands between the database and manifest snapshots", async () => {
    const dataDir = join(root, "data");
    await mkdir(dataDir, { recursive: true });
    const db = openDb(await persistedDatabase(dataDir));
    const coldId = seedColdThread(db, "cold-first");
    const lateId = seedColdThread(db, "moved-late");
    const coldBefore = readRows(db, coldId);
    const lateBefore = readRows(db, lateId);
    const deps = makeDeps(db, dataDir);
    await moveThreadEventsToColdTier(deps, coldId, {
      config: CONFIG,
      now: NOW,
    });

    let late: Awaited<ReturnType<typeof moveThreadEventsToColdTier>> | null =
      null;
    exportHooks.beforeManifestSnapshot = async () => {
      exportHooks.beforeManifestSnapshot = null;
      late = await moveThreadEventsToColdTier(deps, lateId, {
        config: CONFIG,
        now: NOW,
      });
    };
    const restored = await exportAndRestore(db, dataDir);
    expect(late).toMatchObject({ outcome: "moved" });

    expect(isThreadEventsCold(restored.db, lateId)).toBe(false);
    expect(readRows(restored.db, lateId)).toEqual(lateBefore);
    const restoredDeps = makeDeps(restored.db, restored.dataDir);
    const reconciled = await reconcileEventColdTier(restoredDeps, NOW);
    expect(reconciled.classes).toMatchObject({
      committed_no_row: { count: 0 },
      referenced: { count: 1 },
    });
    expect(reconciled.missingLiveSegments).toEqual([]);
    expect((await rehydrateThreadEvents(restoredDeps, coldId)).outcome).toBe(
      "rehydrated",
    );
    expect(readRows(restored.db, coldId)).toEqual(coldBefore);
  });
});
