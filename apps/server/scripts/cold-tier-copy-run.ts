// Runs the event cold tier once against a copy of bb.db and reports counts,
// schema facts and timings only: no thread ids, event ids or row contents.
//
//   node --conditions=source --import tsx scripts/cold-tier-copy-run.ts \
//     --source <bb.db> --work <new directory> [--sample 20] [--report <name>]
//
// The source is opened read-only and copied with the SQLite online backup API
// into <work>/data/bb.db, which must not exist yet; <work> is created mode 700.
// Every write after that goes to the copy, and the report, if named, is a new
// file directly inside <work>. Delete <work> afterwards. The run exits 1 when
// any eligible thread was not moved or any check failed.
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  statSync,
  statfsSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import Database from "better-sqlite3";
import {
  DATABASE_INCREMENTAL_VACUUM_MAX_PAGES,
  countAppliedMigrations,
  createConnection,
  estimateColdMoveSize,
  findColdEligibilityFailure,
  getDatabaseAutoVacuumMode,
  getDatabaseFreelistStats,
  getHighWaterMarks,
  hasStoredSpawnAgentToolCall,
  hasTurnBoundActivePendingInteractionForThread,
  hashColdRowsById,
  listAllColdThreadIds,
  listColdTierCandidateThreadIds,
  listEventColdSegments,
  listOpenBackgroundTaskItemRowsForHost,
  listOpenBackgroundTaskItemRowsForThread,
  listOpenTurnInputAcceptedRowsByThreadIds,
  migrate,
  runIncrementalVacuum,
  selectThreadEventKeeperIds,
  type DbConnection,
} from "@bb/db";
import {
  resolveEventColdTierConfig,
  type EventColdTierConfig,
} from "../src/services/threads/event-cold-tier/config.js";
import { readColdSegmentFile } from "../src/services/threads/event-cold-tier/segment-files.js";
import {
  ensureThreadEventsHot,
  getEventColdTierStatus,
  prepareEventColdTier,
  rehydrateAllThreadEvents,
  rehydrateThreadEvents,
  COLD_SWEEP_CANDIDATE_BATCH,
  runEventColdTierSweep,
  type EventColdTierDeps,
} from "../src/services/threads/event-cold-tier/service.js";
import {
  getLastThreadErrorMessage,
  getLastThreadOutput,
} from "../src/services/threads/thread-data.js";

const CANDIDATE_PAGE = 500;
const CONCURRENT_HYDRATIONS = 8;
const FREE_SPACE_FACTOR = 3;
const MAX_BACKUP_STEPS = 3;

interface Args {
  report: string | null;
  sample: number;
  source: string;
  work: string;
}

function parseArgs(argv: string[]): Args {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined) {
      throw new Error(`Bad arguments near ${flag ?? "end"}`);
    }
    values.set(flag.slice(2), value);
  }
  const source = values.get("source");
  const work = values.get("work");
  if (source === undefined || work === undefined) {
    throw new Error("--source and --work are required");
  }
  if (!isAbsolute(work)) {
    throw new Error("--work must be an absolute path");
  }
  const sample = Number(values.get("sample") ?? "20");
  if (!Number.isInteger(sample) || sample < 0) {
    throw new Error("--sample must be a non-negative integer");
  }
  // The report goes to a new file inside the new work directory, so it can
  // never alias the source database or anything else that already exists.
  const reportName = values.get("report");
  if (
    reportName !== undefined &&
    (reportName === "" ||
      reportName === "." ||
      reportName === ".." ||
      reportName.includes("/") ||
      reportName === "data")
  ) {
    throw new Error("--report must be a plain file name inside --work");
  }
  return {
    report: reportName === undefined ? null : join(work, reportName),
    sample,
    source: resolve(source),
    work,
  };
}

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function fileBytes(path: string): number {
  return existsSync(path) ? statSync(path).size : 0;
}

function elapsed(startedAt: number): number {
  return Math.round(performance.now() - startedAt);
}

function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[
    Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))
  ]!;
}

function countBy<T extends string>(
  values: Iterable<T>,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

function createCountingLogger() {
  const warnings: Record<string, number> = {};
  const errors: Record<string, number> = {};
  const record =
    (bucket: Record<string, number>) => (fields: unknown, message?: string) => {
      const phase =
        typeof fields === "object" && fields !== null && "phase" in fields
          ? String((fields as { phase: unknown }).phase)
          : null;
      const key =
        phase === null ? (message ?? "unknown") : `${message}:${phase}`;
      bucket[key] = (bucket[key] ?? 0) + 1;
    };
  const noop = () => {};
  return {
    errors,
    logger: {
      debug: noop,
      error: record(errors),
      info: noop,
      warn: record(warnings),
    },
    warnings,
  };
}

function threadEventIds(db: DbConnection, threadId: string): string[] {
  return db.$client
    .prepare<[string], { id: string }>(
      "SELECT id FROM events WHERE thread_id = ? ORDER BY sequence",
    )
    .all(threadId)
    .map((row) => row.id);
}

function wholeThreadHash(db: DbConnection, threadId: string) {
  return hashColdRowsById(db, threadId, threadEventIds(db, threadId));
}

function keeperConsumerSnapshot(db: DbConnection, threadId: string): string {
  return sha256({
    error: getLastThreadErrorMessage(db, threadId),
    highWater: getHighWaterMarks(db, [threadId]),
    output: getLastThreadOutput(db, threadId),
    pending: hasTurnBoundActivePendingInteractionForThread(db, threadId),
    spawnAgent: hasStoredSpawnAgentToolCall(db, threadId),
  });
}

function predicateSnapshot(db: DbConnection): Record<string, string> {
  const hostIds = db.$client
    .prepare<[], { host_id: string }>(
      "SELECT DISTINCT host_id FROM environments WHERE host_id IS NOT NULL ORDER BY host_id",
    )
    .all()
    .map((row) => row.host_id);
  const threadIds = db.$client
    .prepare<[], { id: string }>(
      "SELECT id FROM threads WHERE deleted_at IS NULL ORDER BY id",
    )
    .all()
    .map((row) => row.id);
  return {
    backgroundTasksByHost: sha256(
      hostIds.map((hostId) =>
        listOpenBackgroundTaskItemRowsForHost(db, { hostId }),
      ),
    ),
    backgroundTasksByThread: sha256(
      threadIds.map((threadId) =>
        listOpenBackgroundTaskItemRowsForThread(db, { threadId }),
      ),
    ),
    openTurns: sha256(
      listOpenTurnInputAcceptedRowsByThreadIds(db, { threadIds }),
    ),
    pendingInteractions: sha256(
      threadIds.map((threadId) =>
        hasTurnBoundActivePendingInteractionForThread(db, threadId),
      ),
    ),
  };
}

function tableColumns(db: DbConnection, table: string): string[] {
  return db.$client
    .prepare<[], { name: string }>(`PRAGMA table_info(${table})`)
    .all()
    .map((row) => row.name);
}

function listCandidates(
  db: DbConnection,
  config: EventColdTierConfig,
  now: number,
): string[] {
  const all: string[] = [];
  let afterThreadId: string | undefined;
  for (;;) {
    const page = listColdTierCandidateThreadIds(db, {
      afterThreadId,
      limit: CANDIDATE_PAGE,
      minArchivedMs: config.minArchivedMs,
      now,
    });
    all.push(...page);
    if (page.length < CANDIDATE_PAGE) return all;
    afterThreadId = page[page.length - 1];
  }
}

function pickSample(threadIds: string[], size: number): string[] {
  if (threadIds.length <= size) return [...threadIds];
  const step = threadIds.length / size;
  return Array.from(
    { length: size },
    (_, index) => threadIds[Math.floor(index * step)]!,
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const report: Record<string, unknown> = {};
  const timings: Record<string, number> = {};

  // Copy.
  if (existsSync(args.work)) {
    throw new Error("--work must not exist yet");
  }
  const sourceBytes = fileBytes(args.source) + fileBytes(`${args.source}-wal`);
  const parent = dirname(args.work);
  const fs = statfsSync(parent);
  const freeBytes = fs.bavail * fs.bsize;
  report.space = {
    freeBytes,
    required: sourceBytes * FREE_SPACE_FACTOR,
    sourceBytes,
  };
  if (freeBytes < sourceBytes * FREE_SPACE_FACTOR) {
    throw new Error(
      `Not enough free space: ${freeBytes} bytes free, ${sourceBytes * FREE_SPACE_FACTOR} needed`,
    );
  }
  mkdirSync(args.work, { mode: 0o700 });
  const dataDir = join(args.work, "data");
  mkdirSync(dataDir, { mode: 0o700 });
  const copyPath = join(dataDir, "bb.db");
  let startedAt = performance.now();
  const source = new Database(args.source, {
    fileMustExist: true,
    readonly: true,
  });
  // The online backup restarts whenever another connection writes the
  // source. Against a live server that loops forever at the default 100
  // pages per step, so copy every remaining page in a single step, which
  // runs under one read transaction, and abort if it ever restarts.
  let backupSteps = 0;
  try {
    await source.backup(copyPath, {
      progress: () => {
        backupSteps += 1;
        if (backupSteps > MAX_BACKUP_STEPS) {
          throw new Error(
            `Backup restarted ${backupSteps} times; the source is changing under it`,
          );
        }
        return 0x7fffffff;
      },
    });
  } finally {
    source.close();
  }
  timings.copyMs = elapsed(startedAt);

  const db = createConnection(copyPath);
  startedAt = performance.now();
  const migrationsBefore = countAppliedMigrations(db);
  migrate(db);
  timings.migrateMs = elapsed(startedAt);
  report.schema = {
    autoVacuum: getDatabaseAutoVacuumMode(db),
    coldSegmentColumns: tableColumns(db, "event_cold_segments"),
    coldStateColumns: tableColumns(db, "thread_event_cold_state"),
    copyBytesAfterMigrate: fileBytes(copyPath),
    journalMode: db.$client.pragma("journal_mode", { simple: true }),
    migrationsApplied: countAppliedMigrations(db) - migrationsBefore,
  };

  const counting = createCountingLogger();
  const deps = {
    config: { dataDir },
    db,
    hub: { notifyThread: () => {} },
    logger: counting.logger,
  } as unknown as EventColdTierDeps;
  await prepareEventColdTier(deps);

  // Census.
  process.env.BB_EVENT_COLD_TIER = "dry-run";
  const config = resolveEventColdTierConfig();
  const now = Date.now();
  startedAt = performance.now();
  const candidates = listCandidates(db, config, now);
  const exclusions: string[] = [];
  const eligible: string[] = [];
  let eligibleRows = 0;
  let eligibleBytes = 0;
  for (const threadId of candidates) {
    const failure = findColdEligibilityFailure(db, threadId, {
      minArchivedMs: config.minArchivedMs,
      now,
      rehotCooldownMs: config.rehotCooldownMs,
    });
    if (failure !== null) {
      exclusions.push(failure);
      continue;
    }
    const estimate = estimateColdMoveSize(
      db,
      threadId,
      selectThreadEventKeeperIds(db, threadId),
    );
    eligible.push(threadId);
    eligibleRows += estimate.rowCount;
    eligibleBytes += estimate.estimatedBytes;
  }
  timings.censusMs = elapsed(startedAt);
  const totals = db.$client
    .prepare<[], { events: number; threads: number }>(
      "SELECT (SELECT COUNT(*) FROM events) AS events, (SELECT COUNT(*) FROM threads) AS threads",
    )
    .get()!;
  report.census = {
    candidateThreads: candidates.length,
    config,
    eligibleEstimatedBytes: eligibleBytes,
    eligibleRows,
    eligibleThreads: eligible.length,
    excludedByReason: countBy(exclusions),
    totalEvents: totals.events,
    totalThreads: totals.threads,
  };
  const dryRun = await runEventColdTierSweep(deps, now);
  report.dryRunSweep = {
    candidateFound: dryRun.candidate !== null,
    candidateIsEligible:
      dryRun.candidate === null || eligible.includes(dryRun.candidate),
  };

  // Baseline.
  startedAt = performance.now();
  const sample = pickSample(eligible, args.sample);
  const baseline = new Map<
    string,
    { nonKeeper: string; whole: string; rows: number }
  >();
  for (const threadId of eligible) {
    const keepers = new Set(selectThreadEventKeeperIds(db, threadId));
    const nonKeeperIds = threadEventIds(db, threadId).filter(
      (id) => !keepers.has(id),
    );
    const nonKeeper = hashColdRowsById(db, threadId, nonKeeperIds);
    baseline.set(threadId, {
      nonKeeper: nonKeeper.bodySha256,
      rows: nonKeeper.rowCount,
      whole: wholeThreadHash(db, threadId).bodySha256,
    });
  }
  const keeperBefore = new Map(
    sample.map((threadId) => [threadId, keeperConsumerSnapshot(db, threadId)]),
  );
  const predicatesBefore = predicateSnapshot(db);
  timings.baselineMs = elapsed(startedAt);

  // Moves.
  process.env.BB_EVENT_COLD_TIER = "1";
  const sizeBefore = getDatabaseFreelistStats(db);
  const loopDelay = monitorEventLoopDelay({ resolution: 10 });
  loopDelay.enable();
  const seen = new Set<string>();
  const outcomes: string[] = [];
  const phaseMax: Record<string, number> = {};
  let movedRows = 0;
  let movedBytes = 0;
  // One sweep scans at most one candidate batch, so an empty sweep does not
  // mean the scan is over: keep sweeping until enough empty sweeps in a row to
  // wrap the cursor past every candidate. A repeat candidate means a full wrap.
  const maxEmptySweeps =
    Math.ceil(candidates.length / COLD_SWEEP_CANDIDATE_BATCH) + 2;
  let emptySweeps = 0;
  startedAt = performance.now();
  for (;;) {
    const sweep = await runEventColdTierSweep(deps, now);
    if (sweep.candidate === null) {
      emptySweeps += 1;
      if (emptySweeps > maxEmptySweeps) break;
      continue;
    }
    if (seen.has(sweep.candidate)) break;
    emptySweeps = 0;
    seen.add(sweep.candidate);
    const move = sweep.move!;
    outcomes.push(
      move.reason === null ? move.outcome : `${move.outcome}:${move.reason}`,
    );
    if (move.outcome === "moved") {
      movedRows += move.rowCount;
      movedBytes += move.bytes;
    }
    for (const [phase, ms] of Object.entries(move.timings)) {
      phaseMax[phase] = Math.max(phaseMax[phase] ?? 0, Math.round(ms));
    }
  }
  timings.movesMs = elapsed(startedAt);
  loopDelay.disable();
  const movedThreads = new Set(listAllColdThreadIds(db));
  const eligibleNotAttempted = eligible.filter(
    (threadId) => !seen.has(threadId),
  ).length;
  const eligibleNotMoved = eligible.filter(
    (threadId) => !movedThreads.has(threadId),
  ).length;
  report.moves = {
    eligibleNotAttempted,
    eligibleNotMoved,
    eventLoopDelayMs: {
      max: Math.round(loopDelay.max / 1e6),
      p99: Math.round(loopDelay.percentile(99) / 1e6),
    },
    fileBytes: movedBytes,
    maxPhaseMs: phaseMax,
    outcomes: countBy(outcomes),
    rowsMoved: movedRows,
    shareOfEventsMoved: totals.events === 0 ? 0 : movedRows / totals.events,
  };

  // Verify.
  startedAt = performance.now();
  const segments = listEventColdSegments(db, { lifecycle: "live" });
  let segmentMatches = 0;
  const segmentMismatches: string[] = [];
  for (const segment of segments) {
    const expected = baseline.get(segment.threadId);
    if (expected === undefined) {
      segmentMismatches.push("not_in_baseline");
      continue;
    }
    const read = await readColdSegmentFile(dataDir, {
      bodySha256: segment.bodySha256,
      decompressedBytes: segment.decompressedBytes,
      fileBytes: segment.fileBytes,
      fileSha256: segment.fileSha256,
      headerBytes: segment.headerBytes,
      path: segment.path,
      segmentId: segment.segmentId,
      threadId: segment.threadId,
    });
    const bodyHash = createHash("sha256").update(read.body).digest("hex");
    if (bodyHash !== expected.nonKeeper) segmentMismatches.push("body_hash");
    else if (segment.rowCount !== expected.rows)
      segmentMismatches.push("row_count");
    else segmentMatches += 1;
  }
  const coldSample = sample.filter((threadId) =>
    listAllColdThreadIds(db).includes(threadId),
  );
  const keeperMismatches = coldSample.filter(
    (threadId) =>
      keeperConsumerSnapshot(db, threadId) !== keeperBefore.get(threadId),
  ).length;
  const predicatesCold = predicateSnapshot(db);
  timings.verifyMs = elapsed(startedAt);
  report.verify = {
    keeperConsumers: {
      checked: coldSample.length,
      mismatched: keeperMismatches,
    },
    predicatesUnchangedWhileCold: Object.fromEntries(
      Object.keys(predicatesBefore).map((key) => [
        key,
        predicatesBefore[key] === predicatesCold[key],
      ]),
    ),
    segments: {
      live: segments.length,
      matched: segmentMatches,
      mismatched: countBy(segmentMismatches),
    },
  };

  // Vacuum.
  startedAt = performance.now();
  const vacuumPasses: number[] = [];
  let freelist = getDatabaseFreelistStats(db);
  while (freelist.freelistCount > 0 && vacuumPasses.length < 1000) {
    const passStarted = performance.now();
    const result = runIncrementalVacuum(db, {
      maxPages: DATABASE_INCREMENTAL_VACUUM_MAX_PAGES,
    });
    vacuumPasses.push(elapsed(passStarted));
    if (result.after.freelistCount >= freelist.freelistCount) break;
    freelist = result.after;
  }
  db.$client.pragma("wal_checkpoint(TRUNCATE)");
  timings.vacuumMs = elapsed(startedAt);
  report.size = {
    before: sizeBefore,
    after: getDatabaseFreelistStats(db),
    copyFileBytes: fileBytes(copyPath),
    vacuumPassMs: {
      count: vacuumPasses.length,
      max: Math.max(0, ...vacuumPasses),
    },
  };

  // Rehydrate.
  const cold = listAllColdThreadIds(db);
  const largest = segments
    .filter((segment) => cold.includes(segment.threadId))
    .sort((a, b) => b.rowCount - a.rowCount)[0];
  if (largest !== undefined) {
    startedAt = performance.now();
    const result = await rehydrateThreadEvents(deps, largest.threadId);
    report.largestRehydrate = {
      ms: elapsed(startedAt),
      outcome: result.outcome,
      rowCount: result.rowCount,
      timings: Object.fromEntries(
        Object.entries(result.timings).map(([phase, ms]) => [
          phase,
          Math.round(ms),
        ]),
      ),
    };
  }
  const concurrent = listAllColdThreadIds(db).slice(0, CONCURRENT_HYDRATIONS);
  const concurrentStarted = performance.now();
  const latencies = await Promise.all(
    concurrent.map(async (threadId) => {
      await ensureThreadEventsHot(deps, threadId);
      return performance.now() - concurrentStarted;
    }),
  );
  report.concurrentHydration = {
    count: concurrent.length,
    maxMs: Math.round(Math.max(0, ...latencies)),
    p50Ms: Math.round(percentile(latencies, 0.5)),
  };
  startedAt = performance.now();
  const all = await rehydrateAllThreadEvents(deps);
  timings.rehydrateAllMs = elapsed(startedAt);
  let wholeMatches = 0;
  let wholeMismatches = 0;
  for (const [threadId, expected] of baseline) {
    if (wholeThreadHash(db, threadId).bodySha256 === expected.whole)
      wholeMatches += 1;
    else wholeMismatches += 1;
  }
  const predicatesAfter = predicateSnapshot(db);
  const status = await getEventColdTierStatus(deps);
  report.rehydrate = {
    failed: all.failed.length,
    predicatesUnchangedAfterRehydrate: Object.fromEntries(
      Object.keys(predicatesBefore).map((key) => [
        key,
        predicatesBefore[key] === predicatesAfter[key],
      ]),
    ),
    rehydrated: all.rehydrated,
    remainingColdThreads: status.coldThreads,
    wholeThread: { matched: wholeMatches, mismatched: wholeMismatches },
  };
  report.logs = { errors: counting.errors, warnings: counting.warnings };
  report.timings = timings;
  db.$client.close();

  // Qualification: the run only counts when every eligible thread moved and
  // every check came back clean.
  const unchanged = (snapshot: Record<string, string>) =>
    Object.keys(predicatesBefore).every(
      (key) => predicatesBefore[key] === snapshot[key],
    );
  const failures = [
    eligibleNotAttempted > 0 && "eligible_not_attempted",
    eligibleNotMoved > 0 && "eligible_not_moved",
    segmentMismatches.length > 0 && "segment_mismatch",
    keeperMismatches > 0 && "keeper_consumer_mismatch",
    !unchanged(predicatesCold) && "predicate_changed_while_cold",
    !unchanged(predicatesAfter) && "predicate_changed_after_rehydrate",
    largest !== undefined &&
      (report.largestRehydrate as { outcome: string }).outcome !==
        "rehydrated" &&
      "largest_rehydrate_failed",
    all.failed.length > 0 && "rehydrate_failed",
    status.coldThreads > 0 && "threads_left_cold",
    wholeMismatches > 0 && "whole_thread_mismatch",
  ].filter((failure): failure is string => typeof failure === "string");
  report.qualification = { failures, passed: failures.length === 0 };

  const text = `${JSON.stringify(report, null, 2)}\n`;
  if (args.report !== null) {
    writeFileSync(args.report, text, { flag: "wx", mode: 0o600 });
  }
  process.stdout.write(text);
  if (failures.length > 0) process.exitCode = 1;
}

await main();
