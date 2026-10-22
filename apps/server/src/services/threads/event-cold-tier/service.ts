import { performance } from "node:perf_hooks";
import {
  COLD_SEGMENT_FORMAT_VERSION,
  COMPLETED_EVENT_OUTPUT_TRANSFORM_VERSIONS,
  ColdThreadHistoryError,
  ColdTransitionConflictError,
  EVENT_COLD_COLUMNS,
  commitColdMoveInTransaction,
  commitRehydrateInTransaction,
  estimateColdMoveSize,
  findColdEligibilityFailure,
  getEventColdSegment,
  getThreadEventColdStateRow,
  getThreadEventHighWaterSequence,
  hashColdEventIds,
  isThreadEventsCold,
  iterateColdMoveRows,
  listAllColdThreadIds,
  listColdThreadIds,
  listColdTierCandidateThreadIds,
  listEventColdSegments,
  markOrphanedEventColdSegments,
  prepareCompletedEventOutputData,
  prepareLegacyImageGenerationOutputData,
  runColdTransition,
  selectThreadEventKeeperIds,
  serializeColdEventRow,
  type ColdEventRow,
  type ColdSegmentRecord,
  type DbConnection,
  type EventColdSegmentRow,
  type PreparedRetainedOutputRow,
} from "@bb/db";
import type { AppDeps } from "../../../types.js";
import {
  COLD_SEGMENT_READ_LIMIT,
  resolveEventColdTierConfig,
  type EventColdTierConfig,
} from "./config.js";
import {
  ColdManifest,
  readColdManifestEntries,
  type ColdManifestEntry,
  type ColdManifestRecovery,
} from "./manifest.js";
import {
  getThreadHistoryPinCount,
  pinThreadHistories,
  pinThreadHistory,
  type ThreadHistoryPinRelease,
} from "./pins.js";
import { SerialJobQueue } from "./queue.js";
import {
  buildColdSegmentFrame,
  cleanupStaleStagingFiles,
  ColdSegmentReadError,
  generateColdSegmentId,
  isZstdAvailable,
  listColdArchiveFiles,
  readColdSegmentFile,
  sha256Hex,
  writeColdSegmentFile,
  type ColdArchiveFileEntry,
  type ColdSegmentFileFaults,
  type ColdSegmentHeader,
} from "./segment-files.js";

export type EventColdTierDeps = Pick<
  AppDeps,
  "config" | "db" | "hub" | "logger"
>;

export const COLD_REHYDRATE_PARSE_CHUNK_LINES = 2_000;
export const COLD_SLOW_PHASE_THRESHOLD_MS = 250;
export const COLD_SWEEP_CANDIDATE_BATCH = 50;

type MoveBlocker = (threadId: string) => string | null;

const moveBlockers = new Set<MoveBlocker>();

export function registerThreadHistoryMoveBlocker(
  blocker: MoveBlocker,
): () => void {
  moveBlockers.add(blocker);
  return () => {
    moveBlockers.delete(blocker);
  };
}

function findMoveBlock(threadId: string): string | null {
  if (getThreadHistoryPinCount(threadId) > 0) {
    return "pinned";
  }
  for (const blocker of moveBlockers) {
    const reason = blocker(threadId);
    if (reason !== null) {
      return reason;
    }
  }
  return null;
}

export interface ColdTierFaults {
  afterManifestPending?: () => void;
  beforeTransition?: () => void;
  segmentFile?: ColdSegmentFileFaults;
}

interface ColdTierRuntime {
  candidateCursor: string | undefined;
  faults: ColdTierFaults;
  manifest: ColdManifest;
  queue: SerialJobQueue;
  ready: Promise<ColdManifestRecovery> | null;
  rehydrations: Map<string, Promise<void>>;
  zstdWarned: boolean;
}

const runtimes = new WeakMap<object, ColdTierRuntime>();

function getRuntime(
  deps: Pick<EventColdTierDeps, "config" | "db">,
): ColdTierRuntime {
  let runtime = runtimes.get(deps.db);
  if (runtime === undefined) {
    runtime = {
      candidateCursor: undefined,
      faults: {},
      manifest: new ColdManifest(deps.config.dataDir),
      queue: new SerialJobQueue(),
      ready: null,
      rehydrations: new Map(),
      zstdWarned: false,
    };
    runtimes.set(deps.db, runtime);
  }
  return runtime;
}

export function setColdTierFaultsForTesting(
  deps: Pick<EventColdTierDeps, "config" | "db">,
  faults: ColdTierFaults,
): void {
  getRuntime(deps).faults = faults;
}

export function getColdTierQueueForTesting(
  deps: Pick<EventColdTierDeps, "config" | "db">,
): SerialJobQueue {
  return getRuntime(deps).queue;
}

function ensureReady(
  deps: EventColdTierDeps,
  runtime: ColdTierRuntime,
): Promise<ColdManifestRecovery> {
  if (runtime.ready === null) {
    const now = Date.now();
    runtime.ready = (async () => {
      const removed = await cleanupStaleStagingFiles(deps.config.dataDir, now);
      if (removed.length > 0) {
        deps.logger.info(
          { removed: removed.length },
          "Removed stale cold-tier staging files",
        );
      }
      const recovery = await runtime.manifest.recover(now);
      if (recovery.quarantinedPath !== null) {
        deps.logger.warn(
          {
            quarantinedPath: recovery.quarantinedPath,
            tornBytes: recovery.tornBytes,
          },
          "Quarantined a torn cold-tier manifest tail",
        );
      }
      return recovery;
    })();
    runtime.ready.catch(() => {
      runtime.ready = null;
    });
  }
  return runtime.ready;
}

export async function prepareEventColdTier(
  deps: EventColdTierDeps,
): Promise<ColdManifestRecovery> {
  return ensureReady(deps, getRuntime(deps));
}

function notifyHistoryCompacted(
  deps: EventColdTierDeps,
  threadId: string,
): void {
  deps.hub.notifyThread(threadId, ["history-compacted"]);
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function recordPhase(
  deps: EventColdTierDeps,
  timings: Record<string, number>,
  phase: string,
  startedAt: number,
  context: Record<string, unknown>,
): void {
  const elapsedMs = performance.now() - startedAt;
  timings[phase] = Math.max(timings[phase] ?? 0, elapsedMs);
  if (elapsedMs > COLD_SLOW_PHASE_THRESHOLD_MS) {
    deps.logger.warn(
      { ...context, elapsedMs, phase },
      "Slow synchronous cold-tier phase",
    );
  }
}

export async function ensureThreadEventsHot(
  deps: EventColdTierDeps,
  threadId: string,
): Promise<void> {
  if (!isThreadEventsCold(deps.db, threadId)) {
    return;
  }
  const runtime = getRuntime(deps);
  let pending = runtime.rehydrations.get(threadId);
  if (pending === undefined) {
    pending = runtime.queue
      .run(async () => {
        await ensureReady(deps, runtime);
        await rehydrateThreadNow(deps, runtime, threadId);
      })
      .finally(() => {
        runtime.rehydrations.delete(threadId);
      });
    runtime.rehydrations.set(threadId, pending);
  }
  await pending;
  if (isThreadEventsCold(deps.db, threadId)) {
    throw new ColdThreadHistoryError([threadId]);
  }
}

export async function ensureThreadsEventsHot(
  deps: EventColdTierDeps,
  threadIds: Iterable<string>,
): Promise<void> {
  const unique = [...new Set(threadIds)].sort();
  for (const threadId of listColdThreadIds(deps.db, unique).sort()) {
    await ensureThreadEventsHot(deps, threadId);
  }
}

export async function pinAndHydrateThreadHistories(
  deps: EventColdTierDeps,
  threadIds: Iterable<string>,
): Promise<ThreadHistoryPinRelease> {
  const ids = [...new Set(threadIds)].sort();
  const release = pinThreadHistories(ids);
  try {
    await ensureThreadsEventsHot(deps, ids);
  } catch (error) {
    release();
    throw error;
  }
  return release;
}

export async function pinAndHydrateThreadHistory(
  deps: EventColdTierDeps,
  threadId: string,
): Promise<ThreadHistoryPinRelease> {
  const release = pinThreadHistory(threadId);
  try {
    await ensureThreadEventsHot(deps, threadId);
  } catch (error) {
    release();
    throw error;
  }
  return release;
}

export async function withHotThreadHistory<T>(
  deps: EventColdTierDeps,
  threadIds: string | Iterable<string>,
  fn: () => T | Promise<T>,
): Promise<T> {
  const release = await pinAndHydrateThreadHistories(
    deps,
    typeof threadIds === "string" ? [threadIds] : threadIds,
  );
  try {
    return await fn();
  } finally {
    release();
  }
}

export class ColdSelectionRetryError extends Error {
  readonly threadIds: readonly string[];

  constructor(threadIds: readonly string[]) {
    super(
      `Thread selection changed to include unpinned threads: ${threadIds.join(", ")}`,
    );
    this.name = "ColdSelectionRetryError";
    this.threadIds = threadIds;
  }
}

export const COLD_SELECTION_MAX_ATTEMPTS = 3;

export function assertSelectionPinned(
  selected: readonly string[],
  pinned: ReadonlySet<string>,
): void {
  const unpinned = selected.filter((threadId) => !pinned.has(threadId));
  if (unpinned.length > 0) {
    throw new ColdSelectionRetryError(unpinned);
  }
}

export async function withHotSelectedThreadHistories<T>(
  deps: EventColdTierDeps,
  select: () => readonly string[],
  run: (pinned: ReadonlySet<string>) => T | Promise<T>,
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    const selected = [...new Set(select())].sort();
    const release = await pinAndHydrateThreadHistories(deps, selected);
    try {
      return await run(new Set(selected));
    } catch (error) {
      if (
        error instanceof ColdSelectionRetryError &&
        attempt < COLD_SELECTION_MAX_ATTEMPTS
      ) {
        continue;
      }
      throw error;
    } finally {
      release();
    }
  }
}

export type ColdMoveOutcome = "moved" | "skipped" | "aborted";

export interface ColdMoveResult {
  bytes: number;
  outcome: ColdMoveOutcome;
  reason: string | null;
  rowCount: number;
  segmentId: string | null;
  threadId: string;
  timings: Record<string, number>;
}

function currentTransformVersions(): Record<string, number> {
  return { ...COMPLETED_EVENT_OUTPUT_TRANSFORM_VERSIONS };
}

interface CapturedMove {
  body: Buffer;
  eventIds: string[];
  firstSequence: number;
  highWaterSequence: number;
  keeperIds: string[];
  lastSequence: number;
}

function captureMove(
  db: DbConnection,
  threadId: string,
  config: EventColdTierConfig,
): CapturedMove | { skip: string } {
  const keeperIds = selectThreadEventKeeperIds(db, threadId);
  const highWaterSequence = getThreadEventHighWaterSequence(db, threadId);
  const chunks: Buffer[] = [];
  const eventIds: string[] = [];
  let bytes = 0;
  let firstSequence = Number.POSITIVE_INFINITY;
  let lastSequence = Number.NEGATIVE_INFINITY;
  const rows = iterateColdMoveRows(db, threadId, keeperIds);
  try {
    for (const row of rows) {
      const line = Buffer.from(`${serializeColdEventRow(row)}\n`, "utf8");
      bytes += line.length;
      if (bytes > config.maxThreadBytes) {
        return { skip: "too_large" };
      }
      chunks.push(line);
      eventIds.push(row.id);
      firstSequence = Math.min(firstSequence, row.sequence);
      lastSequence = Math.max(lastSequence, row.sequence);
    }
  } finally {
    rows.return?.();
  }
  if (eventIds.length === 0) {
    return { skip: "empty" };
  }
  return {
    body: Buffer.concat(chunks, bytes),
    eventIds,
    firstSequence,
    highWaterSequence,
    keeperIds,
    lastSequence,
  };
}

function eligibilityOptions(config: EventColdTierConfig, now: number) {
  return {
    minArchivedMs: config.minArchivedMs,
    now,
    rehotCooldownMs: config.rehotCooldownMs,
  };
}

export function findColdMoveSkipReason(
  deps: Pick<EventColdTierDeps, "db">,
  threadId: string,
  config: EventColdTierConfig,
  now: number,
): string | null {
  return (
    findColdEligibilityFailure(
      deps.db,
      threadId,
      eligibilityOptions(config, now),
    ) ?? findMoveBlock(threadId)
  );
}

async function moveThreadNow(
  deps: EventColdTierDeps,
  runtime: ColdTierRuntime,
  threadId: string,
  config: EventColdTierConfig,
  now: number,
): Promise<ColdMoveResult> {
  const timings: Record<string, number> = {};
  const result = (
    outcome: ColdMoveOutcome,
    reason: string | null,
    extra: Partial<ColdMoveResult> = {},
  ): ColdMoveResult => ({
    bytes: 0,
    outcome,
    reason,
    rowCount: 0,
    segmentId: null,
    threadId,
    timings,
    ...extra,
  });

  let startedAt = performance.now();
  const skipReason = findColdMoveSkipReason(deps, threadId, config, now);
  if (skipReason !== null) {
    return result("skipped", skipReason);
  }
  const estimate = estimateColdMoveSize(
    deps.db,
    threadId,
    selectThreadEventKeeperIds(deps.db, threadId),
  );
  recordPhase(deps, timings, "estimate", startedAt, { threadId });
  if (estimate.rowCount === 0) {
    return result("skipped", "empty");
  }
  if (estimate.estimatedBytes > config.maxThreadBytes) {
    return result("skipped", "too_large_estimate", {
      bytes: estimate.estimatedBytes,
      rowCount: estimate.rowCount,
    });
  }

  startedAt = performance.now();
  const captured = captureMove(deps.db, threadId, config);
  recordPhase(deps, timings, "capture", startedAt, { threadId });
  if ("skip" in captured) {
    return result("skipped", captured.skip, { rowCount: estimate.rowCount });
  }

  const segmentId = generateColdSegmentId(now);
  const transformVersions = currentTransformVersions();
  const bodySha256 = sha256Hex(captured.body);
  const header: ColdSegmentHeader = {
    bodyBytes: captured.body.length,
    bodySha256,
    eventIds: captured.eventIds,
    firstSequence: captured.firstSequence,
    formatVersion: COLD_SEGMENT_FORMAT_VERSION,
    lastSequence: captured.lastSequence,
    rowCount: captured.eventIds.length,
    segmentId,
    threadId,
    transformVersions,
  };
  const frame = buildColdSegmentFrame(header, captured.body);
  if (frame.decompressedBytes > COLD_SEGMENT_READ_LIMIT) {
    return result("skipped", "frame_ceiling", {
      bytes: frame.decompressedBytes,
      rowCount: captured.eventIds.length,
    });
  }

  startedAt = performance.now();
  const written = await writeColdSegmentFile({
    dataDir: deps.config.dataDir,
    faults: runtime.faults.segmentFile,
    frame,
    segmentId,
    threadId,
  });
  timings.write = performance.now() - startedAt;

  await runtime.manifest.append({
    at: now,
    kind: "pending",
    segmentId,
    threadId,
  });
  runtime.faults.afterManifestPending?.();

  const segment: ColdSegmentRecord = {
    bodySha256,
    createdAt: now,
    decompressedBytes: frame.decompressedBytes,
    eventIdsSha256: hashColdEventIds(captured.eventIds),
    fileBytes: written.fileBytes,
    fileSha256: written.fileSha256,
    firstSequence: captured.firstSequence,
    formatVersion: COLD_SEGMENT_FORMAT_VERSION,
    headerBytes: frame.headerBytes,
    lastSequence: captured.lastSequence,
    path: written.path,
    rowCount: captured.eventIds.length,
    segmentId,
    threadId,
    transformVersions: JSON.stringify(transformVersions),
  };

  runtime.faults.beforeTransition?.();
  startedAt = performance.now();
  try {
    runColdTransition(deps.db, threadId, () => {
      const block = findMoveBlock(threadId);
      if (block !== null) {
        throw new ColdTransitionConflictError(block);
      }
      commitColdMoveInTransaction(deps.db, {
        eligibility: eligibilityOptions(config, now),
        expectedHighWaterSequence: captured.highWaterSequence,
        expectedKeeperIds: captured.keeperIds,
        movedEventIds: captured.eventIds,
        segment,
      });
    });
  } catch (error) {
    recordPhase(deps, timings, "transaction", startedAt, { threadId });
    const reason =
      error instanceof ColdTransitionConflictError
        ? error.reason
        : `transition_failed: ${error instanceof Error ? error.message : String(error)}`;
    await runtime.manifest.append({
      at: Date.now(),
      kind: "aborted",
      reason,
      segmentId,
      threadId,
    });
    deps.logger.info({ reason, segmentId, threadId }, "Cold move aborted");
    return result("aborted", reason, {
      bytes: written.fileBytes,
      rowCount: captured.eventIds.length,
      segmentId,
    });
  }
  recordPhase(deps, timings, "transaction", startedAt, { threadId });
  notifyHistoryCompacted(deps, threadId);
  await runtime.manifest.append({
    at: Date.now(),
    kind: "committed",
    segmentId,
    threadId,
  });
  return result("moved", null, {
    bytes: written.fileBytes,
    rowCount: captured.eventIds.length,
    segmentId,
  });
}

export async function moveThreadEventsToColdTier(
  deps: EventColdTierDeps,
  threadId: string,
  options: { config?: EventColdTierConfig; now?: number } = {},
): Promise<ColdMoveResult> {
  const runtime = getRuntime(deps);
  const config = options.config ?? resolveEventColdTierConfig();
  return runtime.queue.run(async () => {
    await ensureReady(deps, runtime);
    return moveThreadNow(
      deps,
      runtime,
      threadId,
      config,
      options.now ?? Date.now(),
    );
  });
}

function parseTransformVersions(raw: string): Record<string, number> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed === "object" && parsed !== null) {
      return parsed as Record<string, number>;
    }
  } catch {}
  return {};
}

function parseColdRow(line: string, segmentId: string): ColdEventRow {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new ColdSegmentReadError(segmentId, "row is not JSON");
  }
  if (typeof value !== "object" || value === null) {
    throw new ColdSegmentReadError(segmentId, "row is not an object");
  }
  const record = value as Record<string, unknown>;
  for (const column of EVENT_COLD_COLUMNS) {
    if (!(column in record)) {
      throw new ColdSegmentReadError(segmentId, `row is missing ${column}`);
    }
  }
  return record as unknown as ColdEventRow;
}

interface PreparedRehydrate {
  retainedOutputs: PreparedRetainedOutputRow[];
  rows: ColdEventRow[];
}

function applyPendingTransforms(
  rows: ColdEventRow[],
  fileVersions: Record<string, number>,
  now: number,
): PreparedRehydrate {
  const current = COMPLETED_EVENT_OUTPUT_TRANSFORM_VERSIONS;
  const completedPending =
    (fileVersions.completedEventOutputSidecar ?? 0) <
    current.completedEventOutputSidecar;
  const legacyPending =
    (fileVersions.legacyImageGenerationOutputSidecar ?? 0) <
    current.legacyImageGenerationOutputSidecar;
  const retainedOutputs: PreparedRetainedOutputRow[] = [];
  if (!completedPending && !legacyPending) {
    return { retainedOutputs, rows };
  }
  const prepared = rows.map((row) => {
    let data = row.data;
    if (completedPending) {
      const result = prepareCompletedEventOutputData({
        createdAt: row.created_at,
        data,
        itemKind: row.item_kind as Parameters<
          typeof prepareCompletedEventOutputData
        >[0]["itemKind"],
        type: row.type as Parameters<
          typeof prepareCompletedEventOutputData
        >[0]["type"],
      });
      data = result.data;
      if (result.retainedOutput !== null) {
        retainedOutputs.push({ eventId: row.id, ...result.retainedOutput });
      }
    }
    if (legacyPending) {
      const result = prepareLegacyImageGenerationOutputData({
        createdAt: row.created_at,
        data,
      });
      data = result.data;
      if (result.retainedOutput !== null) {
        retainedOutputs.push({ eventId: row.id, ...result.retainedOutput });
      }
    }
    return data === row.data ? row : { ...row, data };
  });
  return {
    retainedOutputs: retainedOutputs.filter((output) => output.expiresAt > now),
    rows: prepared,
  };
}

async function readSegmentRows(
  deps: EventColdTierDeps,
  segment: EventColdSegmentRow,
  timings: Record<string, number>,
): Promise<ColdEventRow[]> {
  const { body, header } = await readColdSegmentFile(
    deps.config.dataDir,
    segment,
  );
  if (header.formatVersion !== COLD_SEGMENT_FORMAT_VERSION) {
    throw new ColdSegmentReadError(
      segment.segmentId,
      `unsupported format version ${header.formatVersion}`,
    );
  }
  const text = body.toString("utf8");
  const rows: ColdEventRow[] = [];
  let offset = 0;
  while (offset < text.length) {
    const startedAt = performance.now();
    for (
      let line = 0;
      line < COLD_REHYDRATE_PARSE_CHUNK_LINES && offset < text.length;
      line += 1
    ) {
      const newline = text.indexOf("\n", offset);
      if (newline === -1) {
        throw new ColdSegmentReadError(
          segment.segmentId,
          "body is not newline-terminated",
        );
      }
      const row = parseColdRow(text.slice(offset, newline), segment.segmentId);
      if (row.thread_id !== segment.threadId) {
        throw new ColdSegmentReadError(
          segment.segmentId,
          "row thread mismatch",
        );
      }
      rows.push(row);
      offset = newline + 1;
    }
    recordPhase(deps, timings, "parseChunk", startedAt, {
      segmentId: segment.segmentId,
    });
    await yieldToEventLoop();
  }
  if (
    rows.length !== segment.rowCount ||
    header.rowCount !== segment.rowCount ||
    hashColdEventIds(rows.map((row) => row.id)) !== segment.eventIdsSha256
  ) {
    throw new ColdSegmentReadError(segment.segmentId, "row set mismatch");
  }
  return rows;
}

export interface ColdRehydrateResult {
  outcome: "rehydrated" | "already_hot";
  rowCount: number;
  segmentId: string | null;
  threadId: string;
  timings: Record<string, number>;
}

async function rehydrateThreadNow(
  deps: EventColdTierDeps,
  runtime: ColdTierRuntime,
  threadId: string,
): Promise<ColdRehydrateResult> {
  const timings: Record<string, number> = {};
  const state = getThreadEventColdStateRow(deps.db, threadId);
  if (state?.state !== "cold" || state.liveSegmentId === null) {
    return {
      outcome: "already_hot",
      rowCount: 0,
      segmentId: null,
      threadId,
      timings,
    };
  }
  const segmentId = state.liveSegmentId;
  const segment = getEventColdSegment(deps.db, segmentId);
  try {
    if (segment === null || segment.lifecycle !== "live") {
      throw new ColdSegmentReadError(segmentId, "live segment row is missing");
    }
    const rows = await readSegmentRows(deps, segment, timings);
    const now = Date.now();
    let startedAt = performance.now();
    const prepared = applyPendingTransforms(
      rows,
      parseTransformVersions(segment.transformVersions),
      now,
    );
    recordPhase(deps, timings, "prepare", startedAt, { threadId });
    startedAt = performance.now();
    runColdTransition(deps.db, threadId, () => {
      commitRehydrateInTransaction(deps.db, {
        now,
        retainedOutputs: prepared.retainedOutputs,
        rows: prepared.rows,
        segmentId,
        threadId,
      });
    });
    recordPhase(deps, timings, "transaction", startedAt, { threadId });
    notifyHistoryCompacted(deps, threadId);
    await runtime.manifest.append({
      at: now,
      kind: "rehydrated",
      segmentId,
      threadId,
    });
    return {
      outcome: "rehydrated",
      rowCount: rows.length,
      segmentId,
      threadId,
      timings,
    };
  } catch (error) {
    deps.logger.error(
      {
        error: error instanceof Error ? error.message : String(error),
        segmentId,
        threadId,
      },
      "Cold thread history could not be rehydrated",
    );
    throw error;
  }
}

export async function rehydrateThreadEvents(
  deps: EventColdTierDeps,
  threadId: string,
): Promise<ColdRehydrateResult> {
  const runtime = getRuntime(deps);
  return runtime.queue.run(async () => {
    await ensureReady(deps, runtime);
    return rehydrateThreadNow(deps, runtime, threadId);
  });
}

export interface ColdRehydrateAllResult {
  failed: Array<{ error: string; threadId: string }>;
  rehydrated: number;
}

export async function rehydrateAllThreadEvents(
  deps: EventColdTierDeps,
): Promise<ColdRehydrateAllResult> {
  const result: ColdRehydrateAllResult = { failed: [], rehydrated: 0 };
  for (const threadId of listAllColdThreadIds(deps.db)) {
    try {
      const outcome = await rehydrateThreadEvents(deps, threadId);
      if (outcome.outcome === "rehydrated") {
        result.rehydrated += 1;
      }
    } catch (error) {
      result.failed.push({
        error: error instanceof Error ? error.message : String(error),
        threadId,
      });
    }
  }
  return result;
}

export const COLD_ARCHIVE_FILE_CLASSES = [
  "referenced",
  "ended",
  "committed_no_row",
  "uncertain",
  "aborted",
  "unknown",
] as const;

export type ColdArchiveFileClass = (typeof COLD_ARCHIVE_FILE_CLASSES)[number];

export interface ColdArchiveClassTotals {
  bytes: number;
  count: number;
}

export interface ColdArchiveClassification {
  classes: Record<ColdArchiveFileClass, ColdArchiveClassTotals>;
  inconsistencies: Array<{ reason: string; segmentId: string }>;
  missingLiveSegments: string[];
}

function emptyClasses(): Record<ColdArchiveFileClass, ColdArchiveClassTotals> {
  return Object.fromEntries(
    COLD_ARCHIVE_FILE_CLASSES.map((name) => [name, { bytes: 0, count: 0 }]),
  ) as Record<ColdArchiveFileClass, ColdArchiveClassTotals>;
}

export function classifyColdArchiveFiles(args: {
  entries: readonly ColdManifestEntry[];
  files: readonly ColdArchiveFileEntry[];
  segments: readonly EventColdSegmentRow[];
}): ColdArchiveClassification {
  const segmentsById = new Map(
    args.segments.map((row) => [row.segmentId, row]),
  );
  const kindsBySegment = new Map<string, Set<string>>();
  for (const entry of args.entries) {
    let kinds = kindsBySegment.get(entry.segmentId);
    if (kinds === undefined) {
      kinds = new Set();
      kindsBySegment.set(entry.segmentId, kinds);
    }
    kinds.add(entry.kind);
  }
  const classes = emptyClasses();
  const inconsistencies: ColdArchiveClassification["inconsistencies"] = [];
  const filePaths = new Set<string>();
  for (const file of args.files) {
    filePaths.add(file.path);
    const row = segmentsById.get(file.segmentId);
    const kinds = kindsBySegment.get(file.segmentId) ?? new Set<string>();
    let fileClass: ColdArchiveFileClass;
    if (row !== undefined && row.path === file.path) {
      fileClass = row.lifecycle === "live" ? "referenced" : "ended";
      if (kinds.has("aborted")) {
        inconsistencies.push({
          reason: "aborted_entry_with_row",
          segmentId: file.segmentId,
        });
      }
    } else if (kinds.has("committed") || kinds.has("rehydrated")) {
      fileClass = "committed_no_row";
    } else if (kinds.has("aborted")) {
      fileClass = "aborted";
    } else if (kinds.has("pending")) {
      fileClass = "uncertain";
    } else {
      fileClass = "unknown";
    }
    classes[fileClass].count += 1;
    classes[fileClass].bytes += file.bytes;
  }
  const missingLiveSegments = args.segments
    .filter((row) => row.lifecycle === "live" && !filePaths.has(row.path))
    .map((row) => row.segmentId)
    .sort();
  return { classes, inconsistencies, missingLiveSegments };
}

export interface ColdReconcileResult extends ColdArchiveClassification {
  orphaned: string[];
  repairedCommitted: string[];
}

export async function reconcileEventColdTier(
  deps: EventColdTierDeps,
  now = Date.now(),
): Promise<ColdReconcileResult> {
  const runtime = getRuntime(deps);
  return runtime.queue.run(async () => {
    await ensureReady(deps, runtime);
    const orphaned = markOrphanedEventColdSegments(deps.db, now);
    const entries = await readColdManifestEntries(deps.config.dataDir);
    const kindsBySegment = new Map<string, Set<string>>();
    for (const entry of entries) {
      const kinds = kindsBySegment.get(entry.segmentId) ?? new Set<string>();
      kinds.add(entry.kind);
      kindsBySegment.set(entry.segmentId, kinds);
    }
    const repairedCommitted: string[] = [];
    for (const [segmentId, kinds] of [...kindsBySegment].sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      if (!kinds.has("pending") || kinds.has("committed")) {
        continue;
      }
      const row = getEventColdSegment(deps.db, segmentId);
      if (row === null) {
        continue;
      }
      await runtime.manifest.append({
        at: now,
        kind: "committed",
        reason: "reconciled",
        segmentId,
        threadId: row.threadId,
      });
      repairedCommitted.push(segmentId);
    }
    const classification = classifyColdArchiveFiles({
      entries: await readColdManifestEntries(deps.config.dataDir),
      files: await listColdArchiveFiles(deps.config.dataDir),
      segments: listEventColdSegments(deps.db),
    });
    for (const inconsistency of classification.inconsistencies) {
      deps.logger.warn(
        inconsistency,
        "Cold-tier manifest disagrees with the database",
      );
    }
    for (const segmentId of classification.missingLiveSegments) {
      deps.logger.error({ segmentId }, "Live cold segment file is missing");
    }
    return { ...classification, orphaned, repairedCommitted };
  });
}

export interface EventColdTierStatus extends ColdArchiveClassification {
  coldThreads: number;
  config: EventColdTierConfig;
  queueDepth: number;
  segments: Record<string, number>;
  zstdAvailable: boolean;
}

export async function getEventColdTierStatus(
  deps: EventColdTierDeps,
): Promise<EventColdTierStatus> {
  const runtime = getRuntime(deps);
  const segmentRows = listEventColdSegments(deps.db);
  const segments: Record<string, number> = {
    live: 0,
    orphaned: 0,
    rehydrated: 0,
  };
  for (const row of segmentRows) {
    segments[row.lifecycle] = (segments[row.lifecycle] ?? 0) + 1;
  }
  const classification = classifyColdArchiveFiles({
    entries: await readColdManifestEntries(deps.config.dataDir),
    files: await listColdArchiveFiles(deps.config.dataDir),
    segments: segmentRows,
  });
  return {
    ...classification,
    coldThreads: listAllColdThreadIds(deps.db).length,
    config: resolveEventColdTierConfig(),
    queueDepth: runtime.queue.depth,
    segments,
    zstdAvailable: isZstdAvailable(),
  };
}

export interface ColdTierSweepResult {
  candidate: string | null;
  dryRun?: { estimatedBytes: number; rowCount: number };
  move?: ColdMoveResult;
  mode: EventColdTierConfig["mode"];
}

export async function runEventColdTierSweep(
  deps: EventColdTierDeps,
  now: number,
): Promise<ColdTierSweepResult> {
  const config = resolveEventColdTierConfig();
  if (config.mode === "off") {
    return { candidate: null, mode: config.mode };
  }
  const runtime = getRuntime(deps);
  if (!isZstdAvailable()) {
    if (!runtime.zstdWarned) {
      runtime.zstdWarned = true;
      deps.logger.warn({}, "Cold tier is disabled: zstd is unavailable");
    }
    return { candidate: null, mode: config.mode };
  }
  if (runtime.queue.depth > 0) {
    return { candidate: null, mode: config.mode };
  }
  await ensureReady(deps, runtime);
  if (config.maxThreadBytesClamped) {
    deps.logger.warn(
      { maxThreadBytes: config.maxThreadBytes },
      "BB_EVENT_COLD_MAX_THREAD_BYTES was clamped to the segment read limit",
    );
  }
  const startedAt = performance.now();
  let candidate: string | null = null;
  for (let pass = 0; pass < 2 && candidate === null; pass += 1) {
    const batch = listColdTierCandidateThreadIds(deps.db, {
      afterThreadId: runtime.candidateCursor,
      limit: COLD_SWEEP_CANDIDATE_BATCH,
      minArchivedMs: config.minArchivedMs,
      now,
    });
    if (batch.length === 0) {
      if (runtime.candidateCursor === undefined) {
        break;
      }
      runtime.candidateCursor = undefined;
      continue;
    }
    for (const threadId of batch) {
      runtime.candidateCursor = threadId;
      if (findColdMoveSkipReason(deps, threadId, config, now) === null) {
        candidate = threadId;
        break;
      }
    }
    if (candidate === null) {
      break;
    }
  }
  const selectMs = performance.now() - startedAt;
  if (selectMs > COLD_SLOW_PHASE_THRESHOLD_MS) {
    deps.logger.warn(
      { elapsedMs: selectMs, phase: "select" },
      "Slow synchronous cold-tier phase",
    );
  }
  if (candidate === null) {
    return { candidate: null, mode: config.mode };
  }
  if (config.mode === "dry-run") {
    const estimate = estimateColdMoveSize(
      deps.db,
      candidate,
      selectThreadEventKeeperIds(deps.db, candidate),
    );
    deps.logger.info(
      { ...estimate, threadId: candidate },
      "Cold tier dry-run candidate",
    );
    return { candidate, dryRun: estimate, mode: config.mode };
  }
  const move = await moveThreadEventsToColdTier(deps, candidate, {
    config,
    now,
  });
  deps.logger.info(
    {
      bytes: move.bytes,
      outcome: move.outcome,
      reason: move.reason,
      rowCount: move.rowCount,
      threadId: candidate,
      timings: move.timings,
    },
    "Cold tier move",
  );
  return { candidate, mode: config.mode, move };
}

export function isThreadHistoryPinned(threadId: string): boolean {
  return getThreadHistoryPinCount(threadId) > 0;
}

