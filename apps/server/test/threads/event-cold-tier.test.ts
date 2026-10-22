import {
  mkdtemp,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
  mkdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createEnvironment,
  createProject,
  createThread,
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
import {
  resolveEventColdTierConfig,
  type EventColdTierConfig,
} from "../../src/services/threads/event-cold-tier/config.js";
import {
  ColdManifest,
  ColdManifestCorruptError,
  coldManifestPath,
  readColdManifestEntries,
} from "../../src/services/threads/event-cold-tier/manifest.js";
import { pinThreadHistory } from "../../src/services/threads/event-cold-tier/pins.js";
import {
  buildColdSegmentFrame,
  cleanupStaleStagingFiles,
  ColdSegmentReadError,
  EVENT_ARCHIVE_STAGING_DIRECTORY,
  generateColdSegmentId,
  readColdSegmentFile,
  resolveDataDirPath,
  sha256Hex,
  writeColdSegmentFile,
} from "../../src/services/threads/event-cold-tier/segment-files.js";
import {
  classifyColdArchiveFiles,
  ensureThreadEventsHot,
  getEventColdTierStatus,
  moveThreadEventsToColdTier,
  reconcileEventColdTier,
  rehydrateThreadEvents,
  registerThreadHistoryMoveBlocker,
  runEventColdTierSweep,
  setColdTierFaultsForTesting,
  withHotThreadHistory,
  type EventColdTierDeps,
} from "../../src/services/threads/event-cold-tier/service.js";

const DAY_MS = 24 * 60 * 60_000;
const NOW = 100 * DAY_MS;

const CONFIG: EventColdTierConfig = {
  maxThreadBytes: 32 * 1024 * 1024,
  maxThreadBytesClamped: false,
  minArchivedMs: 14 * DAY_MS,
  mode: "on",
  rehotCooldownMs: 7 * DAY_MS,
};

let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "bb-cold-tier-test-"));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(dataDir, { force: true, recursive: true });
});

function makeDeps(db: DbConnection) {
  const notifyThread = vi.fn();
  const logger = {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };
  const deps = {
    config: { dataDir },
    db,
    hub: { notifyThread },
    logger,
  } as unknown as EventColdTierDeps;
  return { deps, logger, notifyThread };
}

function setup() {
  const db = createMigratedConnection();
  const host = upsertHost(db, noopNotifier, { name: "test-host" });
  const { project } = createProject(db, noopNotifier, {
    name: "test-project",
    source: { type: "local_path", hostId: host.id, path: "/tmp/test" },
  });
  const environment = createEnvironment(db, noopNotifier, {
    projectId: project.id,
    hostId: host.id,
    path: "/tmp/environment",
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
      data: JSON.stringify({ name: "a" }),
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
  return { db, thread, ...makeDeps(db) };
}

function readRows(db: DbConnection, threadId: string): ColdEventRow[] {
  return db.$client
    .prepare<
      [string],
      ColdEventRow
    >("SELECT * FROM events WHERE thread_id = ? ORDER BY sequence")
    .all(threadId);
}

describe("cold segment files", () => {
  it("writes durably, reads back, and rejects a flipped byte", async () => {
    const segmentId = generateColdSegmentId(NOW);
    const body = Buffer.from('{"a":1}\n{"a":2}\n', "utf8");
    const frame = buildColdSegmentFrame(
      {
        bodyBytes: body.length,
        bodySha256: sha256Hex(body),
        eventIds: ["e1", "e2"],
        firstSequence: 1,
        formatVersion: 1,
        lastSequence: 2,
        rowCount: 2,
        segmentId,
        threadId: "thread-1",
        transformVersions: {},
      },
      body,
    );
    const written = await writeColdSegmentFile({
      dataDir,
      frame,
      segmentId,
      threadId: "thread-1",
    });
    const target = {
      bodySha256: sha256Hex(body),
      decompressedBytes: frame.decompressedBytes,
      fileBytes: written.fileBytes,
      fileSha256: written.fileSha256,
      headerBytes: frame.headerBytes,
      path: written.path,
      segmentId,
      threadId: "thread-1",
    };
    const read = await readColdSegmentFile(dataDir, target);
    expect(read.body.equals(body)).toBe(true);
    expect(read.header.eventIds).toEqual(["e1", "e2"]);
    expect(
      (await stat(resolveDataDirPath(dataDir, written.path))).mode & 0o777,
    ).toBe(0o600);

    const absolute = resolveDataDirPath(dataDir, written.path);
    const bytes = await readFile(absolute);
    bytes[bytes.length - 1] ^= 0xff;
    await writeFile(absolute, bytes);
    await expect(readColdSegmentFile(dataDir, target)).rejects.toBeInstanceOf(
      ColdSegmentReadError,
    );
  });

  it("removes only stale staging files", async () => {
    const staging = join(dataDir, EVENT_ARCHIVE_STAGING_DIRECTORY);
    await mkdir(staging, { recursive: true });
    await writeFile(join(staging, "old.tmp"), "x");
    await writeFile(join(staging, "new.tmp"), "x");
    const old = new Date(NOW - 2 * 60 * 60_000);
    await utimes(join(staging, "old.tmp"), old, old);
    const fresh = new Date(NOW);
    await utimes(join(staging, "new.tmp"), fresh, fresh);
    expect(await cleanupStaleStagingFiles(dataDir, NOW)).toEqual(["old.tmp"]);
  });
});

describe("cold manifest", () => {
  it("chains entries, quarantines a torn tail, and refuses mid-file damage", async () => {
    const manifest = new ColdManifest(dataDir);
    await manifest.recover(NOW);
    await manifest.append({
      at: 1,
      kind: "pending",
      segmentId: "s1",
      threadId: "t",
    });
    await manifest.append({
      at: 2,
      kind: "committed",
      segmentId: "s1",
      threadId: "t",
    });
    const entries = await readColdManifestEntries(dataDir);
    expect(entries.map((entry) => entry.kind)).toEqual([
      "pending",
      "committed",
    ]);
    expect(entries[1]!.prev).toBe(entries[0]!.hash);

    const path = coldManifestPath(dataDir);
    const intact = await readFile(path, "utf8");
    await writeFile(path, `${intact}{"at":3,"kind":"pend`);
    const reopened = new ColdManifest(dataDir);
    const recovery = await reopened.recover(NOW);
    expect(recovery.quarantinedPath).not.toBeNull();
    expect(await readFile(path, "utf8")).toBe(intact);
    await reopened.append({
      at: 4,
      kind: "aborted",
      segmentId: "s2",
      threadId: "t",
    });
    expect((await readColdManifestEntries(dataDir)).at(-1)!.prev).toBe(
      entries[1]!.hash,
    );

    const lines = (await readFile(path, "utf8")).split("\n");
    lines[0] = "garbage";
    await writeFile(path, lines.join("\n"));
    await expect(new ColdManifest(dataDir).recover(NOW)).rejects.toBeInstanceOf(
      ColdManifestCorruptError,
    );
  });
});

describe("cold tier service", () => {
  it("moves a settled thread cold and rehydrates it byte for byte", async () => {
    const { db, deps, notifyThread, thread } = setup();
    const before = readRows(db, thread.id);

    const move = await moveThreadEventsToColdTier(deps, thread.id, {
      config: CONFIG,
      now: NOW,
    });
    expect(move).toMatchObject({ outcome: "moved", reason: null });
    expect(move.rowCount).toBeGreaterThan(0);
    expect(isThreadEventsCold(db, thread.id)).toBe(true);
    expect(readRows(db, thread.id).length).toBe(before.length - move.rowCount);
    expect(notifyThread).toHaveBeenCalledWith(thread.id, ["history-compacted"]);
    expect(
      (await readColdManifestEntries(dataDir)).map((entry) => entry.kind),
    ).toEqual(["pending", "committed"]);

    const status = await getEventColdTierStatus(deps);
    expect(status.coldThreads).toBe(1);
    expect(status.classes.referenced.count).toBe(1);

    await Promise.all([
      ensureThreadEventsHot(deps, thread.id),
      ensureThreadEventsHot(deps, thread.id),
    ]);
    expect(readRows(db, thread.id)).toEqual(before);
    expect(getThreadEventColdStateRow(db, thread.id)?.state).toBe("hot");
    expect(getEventColdSegment(db, move.segmentId!)?.lifecycle).toBe(
      "rehydrated",
    );
    expect(
      (await readColdManifestEntries(dataDir)).map((entry) => entry.kind),
    ).toEqual(["pending", "committed", "rehydrated"]);
    expect((await rehydrateThreadEvents(deps, thread.id)).outcome).toBe(
      "already_hot",
    );

    const ended = await reconcileEventColdTier(deps, NOW);
    expect(ended.classes.ended.count).toBe(1);
    expect(ended.missingLiveSegments).toEqual([]);
  });

  it("aborts and keeps rows hot when a pin lands before the transition", async () => {
    const { db, deps, thread } = setup();
    const before = readRows(db, thread.id);
    let release: (() => void) | undefined;
    setColdTierFaultsForTesting(deps, {
      beforeTransition: () => {
        release = pinThreadHistory(thread.id);
      },
    });

    const move = await moveThreadEventsToColdTier(deps, thread.id, {
      config: CONFIG,
      now: NOW,
    });
    release?.();
    expect(move).toMatchObject({ outcome: "aborted", reason: "pinned" });
    expect(readRows(db, thread.id)).toEqual(before);
    expect(isThreadEventsCold(db, thread.id)).toBe(false);
    expect(
      (await readColdManifestEntries(dataDir)).map((entry) => entry.kind),
    ).toEqual(["pending", "aborted"]);

    const reconciled = await reconcileEventColdTier(deps, NOW);
    expect(reconciled.classes.aborted.count).toBe(1);
    expect(reconciled.classes.referenced.count).toBe(0);
  });

  it("skips pinned threads and threads a registered blocker holds", async () => {
    const { deps, thread } = setup();
    const release = pinThreadHistory(thread.id);
    expect(
      await moveThreadEventsToColdTier(deps, thread.id, {
        config: CONFIG,
        now: NOW,
      }),
    ).toMatchObject({ outcome: "skipped", reason: "pinned" });
    release();

    const unregister = registerThreadHistoryMoveBlocker((id) =>
      id === thread.id ? "lifecycle_in_flight" : null,
    );
    try {
      expect(
        await moveThreadEventsToColdTier(deps, thread.id, {
          config: CONFIG,
          now: NOW,
        }),
      ).toMatchObject({ outcome: "skipped", reason: "lifecycle_in_flight" });
    } finally {
      unregister();
    }
  });

  it("skips a thread above the byte limit before writing anything", async () => {
    const { deps, thread } = setup();
    const move = await moveThreadEventsToColdTier(deps, thread.id, {
      config: { ...CONFIG, maxThreadBytes: 128 },
      now: NOW,
    });
    expect(move.outcome).toBe("skipped");
    expect(["too_large_estimate", "too_large"]).toContain(move.reason);
    expect(await readColdManifestEntries(dataDir)).toEqual([]);
  });

  it("rehydrates inside withHotThreadHistory and holds the pin for the callback", async () => {
    const { db, deps, thread } = setup();
    await moveThreadEventsToColdTier(deps, thread.id, {
      config: CONFIG,
      now: NOW,
    });
    expect(isThreadEventsCold(db, thread.id)).toBe(true);
    const seen = await withHotThreadHistory(deps, thread.id, async () => {
      const blocked = await moveThreadEventsToColdTier(deps, thread.id, {
        config: CONFIG,
        now: Date.now() + 30 * DAY_MS,
      });
      return { blocked, cold: isThreadEventsCold(db, thread.id) };
    });
    expect(seen.cold).toBe(false);
    expect(seen.blocked).toMatchObject({
      outcome: "skipped",
      reason: "pinned",
    });
  });

  it("makes a live row with a missing file an error, not a silent loss", async () => {
    const { db, deps, thread } = setup();
    const move = await moveThreadEventsToColdTier(deps, thread.id, {
      config: CONFIG,
      now: NOW,
    });
    await rm(
      resolveDataDirPath(
        dataDir,
        getEventColdSegment(db, move.segmentId!)!.path,
      ),
    );
    await expect(ensureThreadEventsHot(deps, thread.id)).rejects.toThrow();
    expect(isThreadEventsCold(db, thread.id)).toBe(true);
    const reconciled = await reconcileEventColdTier(deps, NOW);
    expect(reconciled.missingLiveSegments).toEqual([move.segmentId]);
  });

  it("does nothing when off and only logs in dry-run", async () => {
    const { db, deps, logger, thread } = setup();
    vi.stubEnv("BB_EVENT_COLD_TIER", "");
    expect(resolveEventColdTierConfig().mode).toBe("off");
    expect(await runEventColdTierSweep(deps, NOW)).toEqual({
      candidate: null,
      mode: "off",
    });

    vi.stubEnv("BB_EVENT_COLD_TIER", "dry-run");
    const dryRun = await runEventColdTierSweep(deps, NOW);
    expect(dryRun.candidate).toBe(thread.id);
    expect(dryRun.dryRun?.rowCount).toBeGreaterThan(0);
    expect(isThreadEventsCold(db, thread.id)).toBe(false);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: thread.id }),
      "Cold tier dry-run candidate",
    );

    vi.stubEnv("BB_EVENT_COLD_TIER", "1");
    const live = await runEventColdTierSweep(deps, NOW);
    expect(live.move?.outcome).toBe("moved");
    expect(isThreadEventsCold(db, thread.id)).toBe(true);
  });
});

describe("classifyColdArchiveFiles", () => {
  it("lets a database row decide first, then committed over aborted over pending", () => {
    const file = (segmentId: string) => ({
      bytes: 10,
      path: `event-archive/t/${segmentId}.jsonl.zst`,
      segmentId,
      threadId: "t",
    });
    const entry = (
      segmentId: string,
      kind: "pending" | "committed" | "aborted",
    ) => ({
      at: 0,
      hash: "",
      kind,
      prev: "",
      segmentId,
      threadId: "t",
    });
    const row = (segmentId: string, lifecycle: string) =>
      ({
        lifecycle,
        path: `event-archive/t/${segmentId}.jsonl.zst`,
        segmentId,
      }) as never;
    const result = classifyColdArchiveFiles({
      entries: [
        entry("live", "aborted"),
        entry("committed", "pending"),
        entry("committed", "committed"),
        entry("aborted", "pending"),
        entry("aborted", "aborted"),
        entry("pending", "pending"),
      ],
      files: ["live", "ended", "committed", "aborted", "pending", "stray"].map(
        file,
      ),
      segments: [
        row("live", "live"),
        row("ended", "rehydrated"),
        row("gone", "live"),
      ],
    });
    expect(
      Object.fromEntries(
        Object.entries(result.classes).map(([name, totals]) => [
          name,
          totals.count,
        ]),
      ),
    ).toEqual({
      aborted: 1,
      committed_no_row: 1,
      ended: 1,
      referenced: 1,
      uncertain: 1,
      unknown: 1,
    });
    expect(result.inconsistencies).toEqual([
      { reason: "aborted_entry_with_row", segmentId: "live" },
    ]);
    expect(result.missingLiveSegments).toEqual(["gone"]);
  });
});
