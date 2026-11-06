import { readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import Database from "better-sqlite3";

import {
  DEFAULT_ADMISSION_LIMITS,
  DEFAULT_MEMORY_POLICY,
  admitMemory,
  measureValue,
  validatePlaceholder,
  type AdmissionLimits,
  type MemoryAdmissionPolicy,
  type MemoryAdmissionProvider,
  type MemoryReservation,
  type OversizedPlaceholder,
} from "./admission.js";
import type { NormalizedRecord } from "./contracts.js";
import { mergeMayRun, readFtsStructure } from "./fts-structure.js";
import {
  MEMORY_PRESSURE_META_KEY,
  RECENT_FAILURE_LIMIT,
  attributeMemoryFailure,
  parseMemoryPressureState,
  sameGenerationFailures,
  type Attribution,
  type MemoryPressureState,
} from "./memory-pressure.js";
import {
  FTS_AUTOMERGE,
  FTS_CRISISMERGE,
  MIGRATIONS,
  validateMigrations,
  type StoreMigration,
} from "./migrations.js";
import {
  preparePrivateDirectory,
  preparePrivateFile,
  tightenPrivateFileIfPresent,
} from "./private-fs.js";
import {
  COUNTER_LIMIT,
  composeRowid,
  isValidEventMs,
  serializeRowid,
} from "./rowid.js";

const GIB = 1024 * 1024 * 1024;
const MIB = 1024 * 1024;
const WAL_FRAME_HEADER_BYTES = 24;

export interface StoreLimits {
  pageSize: number;
  maxDbBytes: number;
  walAllowanceBytes: number;
  reserveBytes: number;
  cacheKiB: number;
  highWatermarkBytes: number;
  lowWatermarkBytes: number;
  vacuumBatchPages: number;
  walAutoCheckpointPages: number;
  maxRecordTextBytes: number;
  maxBatchRecords: number;
  maxBatchDirtyBytes: number;
  maxBatchInputBytes: number;
  maxBatchAccountedBytes: number;
  maxQuarantineRows: number;
  totalPressureRatio: number;
}

export const DEFAULT_STORE_LIMITS: StoreLimits = {
  pageSize: 4096,
  maxDbBytes: 3 * GIB,
  walAllowanceBytes: 512 * MIB,
  reserveBytes: 512 * MIB,
  cacheKiB: 8192,
  highWatermarkBytes: 2.75 * GIB,
  lowWatermarkBytes: 2.25 * GIB,
  vacuumBatchPages: 2048,
  walAutoCheckpointPages: 1000,
  maxRecordTextBytes: 1 * MIB,
  maxBatchRecords: 2000,
  maxBatchDirtyBytes: 64 * MIB,
  maxBatchInputBytes: 4 * MIB,
  maxBatchAccountedBytes: 16 * MIB,
  maxQuarantineRows: 10000,
  totalPressureRatio: 0.95,
};

export function totalBudgetBytes(limits: StoreLimits): number {
  return limits.maxDbBytes + limits.walAllowanceBytes + limits.reserveBytes;
}

export function resolveLimits(
  overrides: Partial<StoreLimits> = {},
): StoreLimits {
  const limits = { ...DEFAULT_STORE_LIMITS, ...overrides };
  const { pageSize } = limits;
  if (
    !Number.isInteger(pageSize) ||
    pageSize < 512 ||
    pageSize > 65536 ||
    (pageSize & (pageSize - 1)) !== 0
  ) {
    throw new RangeError("pageSize must be a power of two in [512, 65536]");
  }
  if (
    !Number.isInteger(limits.maxDbBytes) ||
    limits.maxDbBytes % pageSize !== 0
  ) {
    throw new RangeError("maxDbBytes must be a whole number of pages");
  }
  if (
    !(limits.lowWatermarkBytes < limits.highWatermarkBytes) ||
    limits.highWatermarkBytes > limits.maxDbBytes
  ) {
    throw new RangeError("watermarks must satisfy low < high <= maxDbBytes");
  }
  for (const key of [
    "walAllowanceBytes",
    "reserveBytes",
    "cacheKiB",
    "vacuumBatchPages",
    "maxRecordTextBytes",
    "maxBatchRecords",
    "maxBatchDirtyBytes",
    "maxBatchInputBytes",
    "maxBatchAccountedBytes",
    "maxQuarantineRows",
  ] as const) {
    if (!Number.isInteger(limits[key]) || limits[key] <= 0) {
      throw new RangeError(`${key} must be a positive integer`);
    }
  }
  if (
    !Number.isInteger(limits.walAutoCheckpointPages) ||
    limits.walAutoCheckpointPages < 0
  ) {
    throw new RangeError(
      "walAutoCheckpointPages must be a non-negative integer",
    );
  }
  if (!(limits.totalPressureRatio > 0 && limits.totalPressureRatio <= 1)) {
    throw new RangeError("totalPressureRatio must be in (0, 1]");
  }
  return limits;
}

export type StoreErrorCode =
  | "schema_too_new"
  | "reset_required"
  | "config_mismatch"
  | "migration_failed"
  | "migration_no_headroom"
  | "confirmation_required";

export class StoreError extends Error {
  readonly code: StoreErrorCode;

  constructor(code: StoreErrorCode, message: string) {
    super(message);
    this.name = "StoreError";
    this.code = code;
  }
}

export interface StoreTestHooks {
  afterAdmission?: (db: Database.Database) => void;
  afterApply?: (db: Database.Database) => void;
}

export interface StoreMemoryOptions {
  provider: MemoryAdmissionProvider;
  policy?: Partial<MemoryAdmissionPolicy>;
}

export interface OpenStoreOptions {
  limits?: Partial<StoreLimits>;
  migrations?: readonly StoreMigration[];
  now?: () => number;
  testHooks?: StoreTestHooks;
  memory?: StoreMemoryOptions;
}

export interface SourceRef {
  key: string;
  generation: number;
  discoveredAtMs: number;
}

export interface CommitBatch {
  source: SourceRef;
  records: readonly NormalizedRecord[];
  placeholders?: readonly OversizedPlaceholder[];
}

export interface CursorUpdate {
  expected: string | null;
  next: string;
}

export type RefusalCode =
  | "suspended"
  | "invalid_batch"
  | "batch_too_large"
  | "db_capacity"
  | "total_budget"
  | "wal_reserve"
  | "cursor_conflict"
  | "disk_full"
  | "db_page_limit"
  | "memory_budget"
  | "memory_pressure"
  | "out_of_memory";

export type CommitOutcome =
  | "inserted"
  | "replayed"
  | "updated"
  | "corrected"
  | "quarantined";

export interface CommitEntry {
  dedupeKey: string;
  outcome: CommitOutcome;
  rowid: string | null;
  timeBasis: "event" | "discovery" | null;
  reason: string | null;
}

export interface CommitResult {
  committed: boolean;
  refusal: { code: RefusalCode; message: string } | null;
  cursor: string | null;
  epoch: number;
  inserted: number;
  replayed: number;
  updated: number;
  corrected: number;
  quarantined: number;
  unindexed: number;
  estimatedDirtyPages: number;
  mergePossible: boolean;
  entries: CommitEntry[];
}

export interface PhysicalBytes {
  db: number;
  wal: number;
  shm: number;
  tmp: number;
  total: number;
}

export interface StoreSettings {
  journalMode: string;
  autoVacuum: number;
  pageSize: number;
  tempStore: number;
  cacheSize: number;
  mmapSize: number;
  maxPageCount: number;
  foreignKeys: number;
  synchronous: number;
  userVersion: number;
}

export interface CapacitySnapshot {
  pageSize: number;
  pageCount: number;
  freelistCount: number;
  maxPageCount: number;
  allocatedBytes: number;
  liveBytes: number;
  freePages: number;
}

export interface ReclaimResult {
  skipped: boolean;
  ok: boolean;
  batches: number;
  pagesFreed: number;
  allocatedBefore: number;
  allocatedAfter: number;
  fileBytesBefore: number;
  fileBytesAfter: number;
  reachedLowWatermark: boolean;
  reason: string | null;
}

export interface IntegrityReport {
  ok: boolean;
  problems: string[];
}

export interface ResetDiagnostics {
  previousVersion: number | null;
  previousDbBytes: number;
  previousSourceCount: number | null;
  previousContentCount: number | null;
  readError: string | null;
}

type Db = Database.Database;
type Stmt = Database.Statement;

type SearchableRecord = Extract<
  NormalizedRecord,
  { kind: "message" | "tool_call" | "tool_result" }
>;

interface Entry {
  record: SearchableRecord;
  text: string;
  textBytes: number;
  name: string | null;
  callId: string | null;
}

const NOT_SEARCHABLE = new Set(["session", "usage"]);

function searchableText(record: SearchableRecord): string {
  if (record.kind === "tool_call") {
    return `${record.name}\n${record.argumentsText}`;
  }
  return record.text;
}

export function estimateDirtyPages(
  records: readonly { textBytes: number; touches: number }[],
  pageSize: number,
): number {
  const payload = pageSize - 64;
  let pages = 8;
  for (const record of records) {
    const textPages = Math.ceil((record.textBytes + 256) / payload);
    pages += 5 * textPages + 12 + 2 * record.touches;
  }
  return pages;
}

export function applyConnectionPragmas(
  db: Db,
  limits: StoreLimits,
  mode: "writer" | "reader",
): void {
  db.pragma("busy_timeout = 5000");
  db.pragma("temp_store = FILE");
  db.pragma(`cache_size = -${limits.cacheKiB}`);
  db.pragma("mmap_size = 0");
  if (mode === "writer") {
    db.pragma("foreign_keys = ON");
    db.pragma("synchronous = NORMAL");
    db.pragma(`journal_size_limit = ${limits.walAllowanceBytes}`);
    db.pragma(`wal_autocheckpoint = ${limits.walAutoCheckpointPages}`);
  } else {
    db.pragma("query_only = ON");
  }
}

function dbPathOf(dir: string): string {
  return join(dir, "session-search.sqlite3");
}

function tmpDirOf(dir: string): string {
  return join(dir, "tmp");
}

function sizeOf(path: string): number {
  try {
    return statSync(path).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
}

export function openReadonlyConnection(
  dir: string,
  options: { limits?: Partial<StoreLimits> } = {},
): Db {
  const limits = resolveLimits(options.limits);
  const db = new Database(dbPathOf(dir), {
    readonly: true,
    fileMustExist: true,
  });
  applyConnectionPragmas(db, limits, "reader");
  return db;
}

export function openStore(
  dir: string,
  options: OpenStoreOptions = {},
): SessionSearchStore {
  const limits = resolveLimits(options.limits);
  const migrations = options.migrations ?? MIGRATIONS;
  validateMigrations(migrations);
  const dbPath = dbPathOf(dir);
  const tmpDir = tmpDirOf(dir);
  preparePrivateDirectory(dir);
  preparePrivateDirectory(tmpDir);
  preparePrivateFile(dbPath);
  process.env["SQLITE_TMPDIR"] = tmpDir;
  const db = new Database(dbPath);
  try {
    const fresh = db.pragma("page_count", { simple: true }) === 0;
    if (fresh) {
      db.pragma(`page_size = ${limits.pageSize}`);
      db.pragma("auto_vacuum = INCREMENTAL");
    }
    db.pragma("journal_mode = WAL");
    applyConnectionPragmas(db, limits, "writer");
    db.pragma(`max_page_count = ${limits.maxDbBytes / limits.pageSize}`);
    verifyConfig(db, limits);
    migrate(db, migrations, limits, fresh);
    tightenSidecars(dbPath);
    return new SessionSearchStore(
      dir,
      db,
      limits,
      options.now ?? Date.now,
      options.testHooks ?? {},
      options.memory
        ? {
            provider: options.memory.provider,
            policy: { ...DEFAULT_MEMORY_POLICY, ...options.memory.policy },
          }
        : null,
    );
  } catch (error) {
    if (db.open) db.close();
    throw error;
  }
}

function tightenSidecars(dbPath: string): void {
  tightenPrivateFileIfPresent(dbPath);
  tightenPrivateFileIfPresent(`${dbPath}-wal`);
  tightenPrivateFileIfPresent(`${dbPath}-shm`);
}

function verifyConfig(db: Db, limits: StoreLimits): void {
  const pageSize = db.pragma("page_size", { simple: true });
  if (pageSize !== limits.pageSize) {
    throw new StoreError(
      "config_mismatch",
      `store page size ${String(pageSize)} differs from required ${limits.pageSize}; reset and re-ingest`,
    );
  }
  const autoVacuum = db.pragma("auto_vacuum", { simple: true });
  if (autoVacuum !== 2) {
    throw new StoreError(
      "config_mismatch",
      "store is not incremental auto-vacuum; reset and re-ingest",
    );
  }
}

function migrate(
  db: Db,
  migrations: readonly StoreMigration[],
  limits: StoreLimits,
  fresh: boolean,
): void {
  const latest = migrations[migrations.length - 1]!.version;
  const current = db.pragma("user_version", { simple: true }) as number;
  if (current > latest) {
    throw new StoreError(
      "schema_too_new",
      `store schema ${current} is newer than supported ${latest}`,
    );
  }
  const pending = migrations.filter((migration) => migration.version > current);
  if (pending.length === 0) return;
  if (!fresh && current === 0) {
    throw new StoreError(
      "config_mismatch",
      "store has content but no schema version; reset and re-ingest",
    );
  }
  if (!fresh) {
    const blocking = pending.find(
      (migration) => migration.requiresReset === true,
    );
    if (blocking) {
      throw new StoreError(
        "reset_required",
        `migration ${blocking.version} (${blocking.name}) requires an explicit reset and re-ingest`,
      );
    }
  }
  const maxPages = limits.maxDbBytes / limits.pageSize;
  for (const migration of pending) {
    const pageCount = db.pragma("page_count", { simple: true }) as number;
    const freelist = db.pragma("freelist_count", { simple: true }) as number;
    const headroom = maxPages - pageCount + freelist;
    if (migration.stagingPages > headroom) {
      throw new StoreError(
        "migration_no_headroom",
        `migration ${migration.version} needs ${migration.stagingPages} pages but only ${headroom} are available`,
      );
    }
    try {
      db.exec("BEGIN IMMEDIATE");
      migration.up(db);
      db.pragma(`user_version = ${migration.version}`);
      db.exec("COMMIT");
    } catch (error) {
      if (db.inTransaction) db.exec("ROLLBACK");
      throw new StoreError(
        "migration_failed",
        `migration ${migration.version} (${migration.name}) failed: ${(error as Error).message}`,
      );
    }
  }
}

interface CapacityRefusalInfo {
  code: RefusalCode;
  message: string;
}

class CursorConflict extends Error {}

export class SessionSearchStore {
  readonly dir: string;
  readonly dbPath: string;
  readonly tmpDir: string;
  readonly limits: StoreLimits;
  readonly schemaVersion: number;
  private readonly db: Db;
  private readonly now: () => number;
  private readonly hooks: StoreTestHooks;
  private suspendedBy: CapacityRefusalInfo | null = null;
  private memoryState: MemoryPressureState;
  private readonly memory: {
    provider: MemoryAdmissionProvider;
    policy: MemoryAdmissionPolicy;
  } | null;
  private readonly admissionLimits: AdmissionLimits;
  private readonly stmts: {
    ensureSource: Stmt;
    sourceRow: Stmt;
    cursorGet: Stmt;
    cursorSet: Stmt;
    counterGet: Stmt;
    counterSet: Stmt;
    identityGet: Stmt;
    identitySet: Stmt;
    contentInsert: Stmt;
    contentDelete: Stmt;
    contentUpdate: Stmt;
    contentSame: Stmt;
    touchInsert: Stmt;
    touchDelete: Stmt;
    quarantineSet: Stmt;
    quarantineClear: Stmt;
    quarantinePrune: Stmt;
    epochGet: Stmt;
    epochBump: Stmt;
  };

  constructor(
    dir: string,
    db: Db,
    limits: StoreLimits,
    now: () => number,
    hooks: StoreTestHooks = {},
    memory: {
      provider: MemoryAdmissionProvider;
      policy: MemoryAdmissionPolicy;
    } | null = null,
  ) {
    this.hooks = hooks;
    this.memory = memory;
    this.admissionLimits = {
      ...DEFAULT_ADMISSION_LIMITS,
      maxBatchInputBytes: limits.maxBatchInputBytes,
      maxBatchAccountedBytes: limits.maxBatchAccountedBytes,
    };
    this.dir = dir;
    this.dbPath = dbPathOf(dir);
    this.tmpDir = tmpDirOf(dir);
    this.db = db;
    this.limits = limits;
    this.now = now;
    this.schemaVersion = db.pragma("user_version", { simple: true }) as number;
    const storedPressure = db
      .prepare("SELECT value FROM meta WHERE key = ?")
      .get(MEMORY_PRESSURE_META_KEY) as { value: string } | undefined;
    this.memoryState = parseMemoryPressureState(storedPressure?.value);
    const big = (sql: string): Stmt => db.prepare(sql).safeIntegers(true);
    this.stmts = {
      ensureSource: db.prepare(
        "INSERT OR IGNORE INTO source_generation(source_key, generation, first_discovery_ms) VALUES (?, ?, ?)",
      ),
      sourceRow: big(
        "SELECT id, first_discovery_ms FROM source_generation WHERE source_key = ? AND generation = ?",
      ),
      cursorGet: db.prepare(
        "SELECT position FROM source_cursor WHERE source_id = ?",
      ),
      cursorSet: db.prepare(
        "INSERT INTO source_cursor(source_id, position, updated_ms) VALUES (?, ?, ?) ON CONFLICT(source_id) DO UPDATE SET position = excluded.position, updated_ms = excluded.updated_ms",
      ),
      counterGet: big("SELECT next_counter FROM ms_counter WHERE event_ms = ?"),
      counterSet: db.prepare(
        "INSERT INTO ms_counter(event_ms, next_counter) VALUES (?, ?) ON CONFLICT(event_ms) DO UPDATE SET next_counter = excluded.next_counter",
      ),
      identityGet: big(
        "SELECT i.content_id AS content_id, c.event_ms AS event_ms, c.time_basis AS time_basis FROM identity i JOIN content c ON c.id = i.content_id WHERE i.dedupe_key = ?",
      ),
      identitySet: db.prepare(
        "INSERT INTO identity(dedupe_key, content_id, source_id) VALUES (?, ?, ?) ON CONFLICT(dedupe_key) DO UPDATE SET content_id = excluded.content_id, source_id = excluded.source_id",
      ),
      contentInsert: db.prepare(
        "INSERT INTO content(id, source_id, dedupe_key, kind, provider, session_id, agent_id, sidechain, call_id, name, cwd, event_ms, time_basis, text) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ),
      contentDelete: db.prepare("DELETE FROM content WHERE id = ?"),
      contentUpdate: db.prepare(
        "UPDATE content SET text = ?, name = ?, call_id = ?, cwd = ? WHERE id = ?",
      ),
      contentSame: db.prepare(
        "SELECT (text = ? AND IFNULL(name, '') = ? AND IFNULL(call_id, '') = ? AND IFNULL(cwd, '') = ?) AS same FROM content WHERE id = ?",
      ),
      touchInsert: db.prepare(
        "INSERT OR IGNORE INTO touch(content_id, path, access, confidence) VALUES (?, ?, ?, ?)",
      ),
      touchDelete: db.prepare("DELETE FROM touch WHERE content_id = ?"),
      quarantineSet: db.prepare(
        "INSERT INTO quarantine(source_id, dedupe_key, reason, event_ms, created_ms, start_offset, end_offset, byte_length) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(dedupe_key) DO UPDATE SET reason = excluded.reason, event_ms = excluded.event_ms, created_ms = excluded.created_ms, start_offset = excluded.start_offset, end_offset = excluded.end_offset, byte_length = excluded.byte_length",
      ),
      quarantineClear: db.prepare(
        "DELETE FROM quarantine WHERE dedupe_key = ?",
      ),
      quarantinePrune: db.prepare(
        "DELETE FROM quarantine WHERE id <= (SELECT id FROM quarantine ORDER BY id DESC LIMIT 1 OFFSET ?)",
      ),
      epochGet: db.prepare("SELECT value FROM meta WHERE key = 'rowid_epoch'"),
      epochBump: db.prepare(
        "UPDATE meta SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'rowid_epoch'",
      ),
    };
  }

  get suspended(): CapacityRefusalInfo | null {
    if (this.suspendedBy) return this.suspendedBy;
    if (this.memoryState.status === "suspended") {
      return {
        code: "memory_pressure",
        message:
          "store writer suspended after memory pressure; a controlled retry is required",
      };
    }
    return null;
  }

  memoryPressure(): MemoryPressureState {
    return JSON.parse(JSON.stringify(this.memoryState)) as MemoryPressureState;
  }

  recordMemoryPressure(input: {
    source: SourceRef;
    mergePossible?: boolean;
    observedAtMs?: number;
  }): { state: MemoryPressureState; attribution: Attribution } {
    return this.applyMemoryFailure(
      input.source,
      input.mergePossible ?? true,
      input.observedAtMs ?? this.now(),
      false,
    );
  }

  beginControlledRetry(input: { mitigation: string }):
    | { ok: true; state: MemoryPressureState }
    | { ok: false; reason: string } {
    const state = this.memoryState;
    if (state.status !== "suspended") {
      return { ok: false, reason: `store is ${state.status}, not suspended` };
    }
    if (state.retriesUsed > 0) {
      return {
        ok: false,
        reason: "the controlled retry was already spent without a clean commit",
      };
    }
    if (
      typeof input.mitigation !== "string" ||
      input.mitigation.trim().length === 0
    ) {
      return { ok: false, reason: "a recorded mitigation is required" };
    }
    if (!this.memory) {
      return { ok: false, reason: "no memory provider is configured" };
    }
    const headroom = admitMemory(this.memory.provider, this.memory.policy, 0);
    if (!headroom.ok) return { ok: false, reason: headroom.message };
    headroom.reservation.release();
    const next: MemoryPressureState = {
      ...state,
      status: "retry_armed",
      retriesUsed: state.retriesUsed + 1,
      mitigation: input.mitigation.trim(),
    };
    this.persistMemoryState(next);
    this.memoryState = next;
    return { ok: true, state: this.memoryPressure() };
  }

  private persistMemoryState(state: MemoryPressureState): void {
    this.db
      .prepare(
        "INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(MEMORY_PRESSURE_META_KEY, JSON.stringify(state));
  }

  private applyMemoryFailure(
    source: SourceRef,
    mergePossible: boolean,
    observedAtMs: number,
    forceStore: boolean,
  ): { state: MemoryPressureState; attribution: Attribution } {
    const prior = this.memoryState;
    const recent = [
      ...prior.recent,
      {
        sourceKey: source.key,
        generation: source.generation,
        mergePossible,
        atMs: observedAtMs,
      },
    ].slice(-RECENT_FAILURE_LIMIT);
    const failures = sameGenerationFailures(
      recent,
      source.key,
      source.generation,
    );
    let intervening = 0;
    if (failures.length > 0) {
      const earliest = Math.min(...failures.map((failure) => failure.atMs));
      const row = this.db
        .prepare(
          "SELECT count(*) AS n FROM source_cursor c JOIN source_generation g ON g.id = c.source_id WHERE g.source_key != ? AND c.updated_ms > ?",
        )
        .get(source.key, earliest) as { n: number };
      intervening = row.n;
    }
    const attribution: Attribution = forceStore
      ? {
          scope: "store",
          reason:
            "SQLite refused an allocation inside the process; charged to the store",
        }
      : attributeMemoryFailure({
          failures,
          interveningSuccessesFromOtherSources: intervening,
        });
    const next: MemoryPressureState = {
      ...prior,
      totalFailures: prior.totalFailures + 1,
      lastFailureMs: observedAtMs,
      recent,
      status: attribution.scope === "store" ? "suspended" : prior.status,
      consecutiveFailures:
        attribution.scope === "store"
          ? prior.consecutiveFailures + 1
          : prior.consecutiveFailures,
    };
    this.memoryState = next;
    try {
      this.persistMemoryState(next);
    } catch {
      this.suspendedBy ??= {
        code: "out_of_memory",
        message: "memory-pressure state could not be persisted",
      };
    }
    return { state: this.memoryPressure(), attribution };
  }

  private mergePossibleNow(): boolean {
    try {
      return mergeMayRun(readFtsStructure(this.db), {
        automerge: FTS_AUTOMERGE,
        crisismerge: FTS_CRISISMERGE,
      });
    } catch {
      return true;
    }
  }

  resume(): void {
    this.suspendedBy = null;
  }

  epoch(): number {
    const row = this.stmts.epochGet.get() as { value: string } | undefined;
    return row ? Number(row.value) : 0;
  }

  getCursor(source: SourceRef): string | null {
    const row = this.stmts.sourceRow.get(source.key, source.generation) as
      | { id: bigint }
      | undefined;
    if (!row) return null;
    const cursor = this.stmts.cursorGet.get(row.id) as
      | { position: string }
      | undefined;
    return cursor ? cursor.position : null;
  }

  lookupIdentity(dedupeKey: string): {
    rowid: bigint;
    eventMs: bigint;
    timeBasis: "event" | "discovery";
  } | null {
    const row = this.stmts.identityGet.get(dedupeKey) as
      | {
          content_id: bigint;
          event_ms: bigint;
          time_basis: "event" | "discovery";
        }
      | undefined;
    if (!row) return null;
    return {
      rowid: row.content_id,
      eventMs: row.event_ms,
      timeBasis: row.time_basis,
    };
  }

  findByTouchedPath(path: string, limit = 100): bigint[] {
    const rows = this.db
      .prepare(
        "SELECT content_id FROM touch WHERE path = ? ORDER BY content_id DESC LIMIT ?",
      )
      .safeIntegers(true)
      .all(path, limit) as { content_id: bigint }[];
    return rows.map((row) => row.content_id);
  }

  firstDiscoveryMs(source: SourceRef): bigint | null {
    const row = this.stmts.sourceRow.get(source.key, source.generation) as
      | { first_discovery_ms: bigint }
      | undefined;
    return row ? row.first_discovery_ms : null;
  }

  settings(): StoreSettings {
    const read = (name: string): number | string =>
      this.db.pragma(name, { simple: true }) as number | string;
    return {
      journalMode: String(read("journal_mode")),
      autoVacuum: Number(read("auto_vacuum")),
      pageSize: Number(read("page_size")),
      tempStore: Number(read("temp_store")),
      cacheSize: Number(read("cache_size")),
      mmapSize: Number(read("mmap_size")),
      maxPageCount: Number(read("max_page_count")),
      foreignKeys: Number(read("foreign_keys")),
      synchronous: Number(read("synchronous")),
      userVersion: Number(read("user_version")),
    };
  }

  physicalBytes(): PhysicalBytes {
    const db = sizeOf(this.dbPath);
    const wal = sizeOf(`${this.dbPath}-wal`);
    const shm = sizeOf(`${this.dbPath}-shm`);
    let tmp = 0;
    for (const name of readdirSync(this.tmpDir))
      tmp += sizeOf(join(this.tmpDir, name));
    return { db, wal, shm, tmp, total: db + wal + shm + tmp };
  }

  capacity(): CapacitySnapshot {
    const pageSize = this.db.pragma("page_size", { simple: true }) as number;
    const pageCount = this.db.pragma("page_count", { simple: true }) as number;
    const freelistCount = this.db.pragma("freelist_count", {
      simple: true,
    }) as number;
    const maxPageCount = this.db.pragma("max_page_count", {
      simple: true,
    }) as number;
    return {
      pageSize,
      pageCount,
      freelistCount,
      maxPageCount,
      allocatedBytes: pageCount * pageSize,
      liveBytes: (pageCount - freelistCount) * pageSize,
      freePages: maxPageCount - pageCount + freelistCount,
    };
  }

  checkpoint(mode: "PASSIVE" | "FULL" | "RESTART" | "TRUNCATE" = "PASSIVE"): {
    busy: boolean;
    logFrames: number;
    checkpointedFrames: number;
  } {
    const rows = this.db.pragma(`wal_checkpoint(${mode})`) as {
      busy: number;
      log: number;
      checkpointed: number;
    }[];
    const row = rows[0]!;
    tightenSidecars(this.dbPath);
    return {
      busy: row.busy !== 0,
      logFrames: row.log,
      checkpointedFrames: row.checkpointed,
    };
  }

  integrityCheck(): IntegrityReport {
    const problems: string[] = [];
    const quick = this.db.pragma("integrity_check") as {
      integrity_check: string;
    }[];
    for (const row of quick) {
      if (row.integrity_check !== "ok") problems.push(row.integrity_check);
    }
    try {
      this.db.exec(
        "INSERT INTO content_fts(content_fts, rank) VALUES ('integrity-check', 1)",
      );
    } catch (error) {
      problems.push(`fts: ${(error as Error).message}`);
    }
    const orphanIdentity = this.db
      .prepare(
        "SELECT count(*) AS n FROM identity i LEFT JOIN content c ON c.id = i.content_id WHERE c.id IS NULL",
      )
      .get() as { n: number };
    if (orphanIdentity.n !== 0)
      problems.push(`${orphanIdentity.n} identities without content`);
    const unmapped = this.db
      .prepare(
        "SELECT count(*) AS n FROM content c LEFT JOIN identity i ON i.content_id = c.id WHERE i.content_id IS NULL",
      )
      .get() as { n: number };
    if (unmapped.n !== 0)
      problems.push(`${unmapped.n} content rows without identity`);
    const mismatchedRowid = this.db
      .prepare("SELECT count(*) AS n FROM content WHERE (id >> 20) != event_ms")
      .get() as { n: number };
    if (mismatchedRowid.n !== 0)
      problems.push(`${mismatchedRowid.n} rowids disagree with event_ms`);
    return { ok: problems.length === 0, problems };
  }

  reclaim(options: { force?: boolean } = {}): ReclaimResult {
    const before = this.capacity();
    const fileBefore = sizeOf(this.dbPath);
    const result: ReclaimResult = {
      skipped: false,
      ok: true,
      batches: 0,
      pagesFreed: 0,
      allocatedBefore: before.allocatedBytes,
      allocatedAfter: before.allocatedBytes,
      fileBytesBefore: fileBefore,
      fileBytesAfter: fileBefore,
      reachedLowWatermark:
        before.allocatedBytes <= this.limits.lowWatermarkBytes,
      reason: null,
    };
    if (
      !options.force &&
      before.allocatedBytes < this.limits.highWatermarkBytes
    ) {
      result.skipped = true;
      return result;
    }
    let reservation: MemoryReservation | null = null;
    if (this.memory) {
      const admitted = admitMemory(this.memory.provider, this.memory.policy, 0);
      if (!admitted.ok) {
        result.skipped = true;
        result.reason = "memory_deferred";
        return result;
      }
      reservation = admitted.reservation;
    }
    try {
      return this.reclaimAdmitted(before, result, options);
    } finally {
      reservation?.release();
    }
  }

  private reclaimAdmitted(
    before: CapacitySnapshot,
    result: ReclaimResult,
    options: { force?: boolean },
  ): ReclaimResult {
    let capacity = before;
    while (
      capacity.allocatedBytes > this.limits.lowWatermarkBytes &&
      capacity.freelistCount > 0
    ) {
      const excessPages = Math.ceil(
        (capacity.allocatedBytes - this.limits.lowWatermarkBytes) /
          capacity.pageSize,
      );
      const step = Math.min(
        this.limits.vacuumBatchPages,
        capacity.freelistCount,
        Math.max(excessPages, 1),
      );
      this.db.pragma(`incremental_vacuum(${step})`);
      result.batches += 1;
      const checkpoint = this.checkpoint("TRUNCATE");
      const next = this.capacity();
      result.pagesFreed += capacity.pageCount - next.pageCount;
      if (checkpoint.busy && next.pageCount === capacity.pageCount) {
        result.ok = false;
        result.reason = "checkpoint_busy";
        capacity = next;
        break;
      }
      capacity = next;
    }
    result.allocatedAfter = capacity.allocatedBytes;
    result.fileBytesAfter = sizeOf(this.dbPath);
    result.reachedLowWatermark =
      capacity.allocatedBytes <= this.limits.lowWatermarkBytes;
    if (result.ok && !result.reachedLowWatermark) {
      result.ok = false;
      result.reason =
        capacity.freelistCount === 0 ? "no_free_pages" : "not_reached";
    }
    if (result.ok && result.fileBytesAfter > result.fileBytesBefore) {
      result.ok = false;
      result.reason = "no_physical_shrink";
    }
    if (!result.ok && !options.force) {
      this.suspendedBy = {
        code: "db_capacity",
        message: `reclamation failed: ${result.reason ?? "unknown"}`,
      };
    }
    return result;
  }

  removeSource(
    sourceKey: string,
    options: { chunkRows?: number } = {},
  ): number {
    const chunk = options.chunkRows ?? 1000;
    const ids = this.db
      .prepare("SELECT id FROM source_generation WHERE source_key = ?")
      .safeIntegers(true)
      .all(sourceKey) as { id: bigint }[];
    const deleteContent = this.db.prepare(
      "DELETE FROM content WHERE id IN (SELECT id FROM content WHERE source_id = ? LIMIT ?)",
    );
    const deleteIdentity = this.db.prepare(
      "DELETE FROM identity WHERE dedupe_key IN (SELECT dedupe_key FROM identity WHERE source_id = ? LIMIT ?)",
    );
    const deleteSource = this.db.prepare(
      "DELETE FROM source_generation WHERE id = ?",
    );
    let removed = 0;
    for (const { id } of ids) {
      for (;;) {
        const info = this.db
          .transaction(() => deleteContent.run(id, chunk))
          .immediate();
        removed += info.changes;
        if (info.changes < chunk) break;
      }
      for (;;) {
        const info = this.db
          .transaction(() => deleteIdentity.run(id, chunk))
          .immediate();
        if (info.changes < chunk) break;
      }
      this.db.transaction(() => deleteSource.run(id)).immediate();
    }
    return removed;
  }

  commitBatch(batch: CommitBatch, cursor: CursorUpdate): CommitResult {
    const refuse = (code: RefusalCode, message: string): CommitResult =>
      this.refusalResult({ code, message }, batch.source);
    if (this.suspendedBy) {
      return refuse(
        "suspended",
        `ingestion suspended after ${this.suspendedBy.code}: ${this.suspendedBy.message}`,
      );
    }
    if (this.memoryState.status === "suspended") {
      return refuse(
        "memory_pressure",
        "ingestion suspended after memory pressure; a controlled retry is required",
      );
    }
    const measured = measureValue(
      {
        source: batch.source,
        cursor,
        records: batch.records,
        placeholders: batch.placeholders ?? [],
      },
      this.admissionLimits,
    );
    if (!measured.ok) {
      return refuse(
        measured.limit === "depth" ? "invalid_batch" : "memory_budget",
        measured.message,
      );
    }
    const invalid = this.validate(batch, cursor);
    if (invalid) return refuse("invalid_batch", invalid);
    const placeholders = batch.placeholders ?? [];
    if (batch.records.length + placeholders.length > this.limits.maxBatchRecords) {
      return refuse(
        "batch_too_large",
        `batch has ${batch.records.length + placeholders.length} records; limit is ${this.limits.maxBatchRecords}`,
      );
    }
    let reservation: MemoryReservation | null = null;
    if (this.memory) {
      const admitted = admitMemory(
        this.memory.provider,
        this.memory.policy,
        measured.accountedBytes,
      );
      if (!admitted.ok) return refuse("memory_budget", admitted.message);
      reservation = admitted.reservation;
    }
    try {
      return this.commitAdmitted(batch, cursor, placeholders);
    } finally {
      reservation?.release();
    }
  }

  private commitAdmitted(
    batch: CommitBatch,
    cursor: CursorUpdate,
    placeholders: readonly OversizedPlaceholder[],
  ): CommitResult {
    const refuse = (
      code: RefusalCode,
      message: string,
      mergePossible = false,
    ): CommitResult =>
      this.refusalResult({ code, message }, batch.source, mergePossible);
    const entries: Entry[] = [];
    let unindexed = 0;
    let totalBytes = 0;
    for (const record of batch.records) {
      if (NOT_SEARCHABLE.has(record.kind)) {
        unindexed += 1;
        continue;
      }
      const searchable = record as SearchableRecord;
      const text = searchableText(searchable);
      const textBytes = Buffer.byteLength(text, "utf8");
      totalBytes += textBytes;
      entries.push({
        record: searchable,
        text,
        textBytes,
        name: searchable.kind === "tool_call" ? searchable.name : null,
        callId: searchable.kind === "message" ? null : searchable.callId,
      });
    }
    const estimatedDirtyPages = estimateDirtyPages(
      [
        ...entries.map((entry) => ({
          textBytes: Math.min(entry.textBytes, this.limits.maxRecordTextBytes),
          touches:
            entry.record.kind === "tool_call" ? entry.record.touches.length : 0,
        })),
        ...placeholders.map(() => ({ textBytes: 0, touches: 0 })),
      ],
      this.limits.pageSize,
    );
    const estimatedBytes = estimatedDirtyPages * this.limits.pageSize;
    if (estimatedBytes > this.limits.maxBatchDirtyBytes) {
      return refuse(
        "batch_too_large",
        `batch could dirty ${estimatedBytes} bytes (${totalBytes} text bytes); limit is ${this.limits.maxBatchDirtyBytes}`,
      );
    }
    const admission = this.admit(estimatedDirtyPages);
    if (admission) return refuse(admission.code, admission.message);
    const mergePossible = this.mergePossibleNow();
    this.hooks.afterAdmission?.(this.db);

    try {
      const { applied, cleared } = this.db
        .transaction(() => {
          const result = this.applyBatch(batch, cursor, entries, placeholders);
          this.hooks.afterApply?.(this.db);
          let next: MemoryPressureState | null = null;
          if (this.memoryState.status !== "clear") {
            next = {
              ...this.memoryState,
              status: "clear",
              clears: this.memoryState.clears + 1,
              retriesUsed: 0,
              consecutiveFailures: 0,
              mitigation: null,
            };
            this.persistMemoryState(next);
          }
          return { applied: result, cleared: next };
        })
        .immediate();
      if (cleared) this.memoryState = cleared;
      tightenSidecars(this.dbPath);
      return {
        committed: true,
        refusal: null,
        cursor: cursor.next,
        epoch: this.epoch(),
        ...applied,
        unindexed,
        estimatedDirtyPages,
        mergePossible,
      };
    } catch (error) {
      if (this.db.inTransaction) this.db.exec("ROLLBACK");
      if (error instanceof CursorConflict) {
        return refuse("cursor_conflict", error.message, mergePossible);
      }
      const classified = this.classify(error, estimatedDirtyPages);
      if (!classified) throw error;
      if (classified.code === "out_of_memory") {
        this.applyMemoryFailure(batch.source, mergePossible, this.now(), true);
      } else {
        this.suspendedBy = classified;
      }
      return this.refusalResult(classified, batch.source, mergePossible);
    }
  }

  close(): void {
    if (this.db.open) this.db.close();
  }

  private validate(batch: CommitBatch, cursor: CursorUpdate): string | null {
    const { source } = batch;
    if (typeof source.key !== "string" || source.key.length === 0) {
      return "source key must be a non-empty string";
    }
    if (!Number.isSafeInteger(source.generation) || source.generation < 0) {
      return "source generation must be a non-negative safe integer";
    }
    if (!isValidEventMs(source.discoveredAtMs)) {
      return "source discoveredAtMs must be an integer millisecond in [0, 2^43)";
    }
    if (
      typeof cursor.next !== "string" ||
      cursor.next.length === 0 ||
      Buffer.byteLength(cursor.next, "utf8") > 4096
    ) {
      return "cursor.next must be a non-empty string of at most 4096 bytes";
    }
    if (cursor.expected !== null && typeof cursor.expected !== "string") {
      return "cursor.expected must be a string or null";
    }
    if (!Array.isArray(batch.records)) {
      return "records must be an array";
    }
    if (batch.placeholders !== undefined) {
      if (!Array.isArray(batch.placeholders)) {
        return "placeholders must be an array";
      }
      for (const placeholder of batch.placeholders) {
        const problem = validatePlaceholder(placeholder, source);
        if (problem) return problem;
      }
    }
    return null;
  }

  private admit(estimatedDirtyPages: number): CapacityRefusalInfo | null {
    const capacity = this.capacity();
    if (estimatedDirtyPages > capacity.freePages) {
      return {
        code: "db_capacity",
        message: `batch may need ${estimatedDirtyPages} pages; ${capacity.freePages} remain under the page limit`,
      };
    }
    const walFrameBytes = this.limits.pageSize + WAL_FRAME_HEADER_BYTES;
    const estimatedWalBytes = estimatedDirtyPages * walFrameBytes;
    let physical = this.physicalBytes();
    if (physical.wal + estimatedWalBytes > this.limits.walAllowanceBytes) {
      this.checkpoint("TRUNCATE");
      physical = this.physicalBytes();
      if (physical.wal + estimatedWalBytes > this.limits.walAllowanceBytes) {
        return {
          code: "wal_reserve",
          message: `WAL is ${physical.wal} bytes and the batch may add ${estimatedWalBytes}; allowance is ${this.limits.walAllowanceBytes}`,
        };
      }
    }
    const dataBudget = this.limits.maxDbBytes + this.limits.walAllowanceBytes;
    const dataBytes = physical.db + physical.wal + physical.shm;
    if (
      dataBytes + estimatedWalBytes >
      dataBudget * this.limits.totalPressureRatio
    ) {
      return {
        code: "total_budget",
        message: `store uses ${dataBytes} of ${dataBudget} data bytes; batch may add ${estimatedWalBytes}`,
      };
    }
    return null;
  }

  private classify(
    error: unknown,
    estimatedDirtyPages: number,
  ): CapacityRefusalInfo | null {
    const code = (error as { code?: unknown }).code;
    if (code === "SQLITE_NOMEM") {
      return {
        code: "out_of_memory",
        message:
          "SQLite refused an allocation; batch rolled back and the store writer is suspended",
      };
    }
    if (code === "SQLITE_FULL") {
      const capacity = this.capacity();
      if (capacity.freePages < estimatedDirtyPages) {
        return {
          code: "db_page_limit",
          message: "database reached its page limit; batch rolled back",
        };
      }
      return {
        code: "disk_full",
        message: "the filesystem is out of space; batch rolled back",
      };
    }
    return null;
  }

  private refusalResult(
    refusal: CapacityRefusalInfo,
    source?: SourceRef,
    mergePossible = false,
  ): CommitResult {
    let cursor: string | null = null;
    if (source && typeof source.key === "string") {
      try {
        cursor = this.getCursor(source);
      } catch {
        cursor = null;
      }
    }
    return {
      committed: false,
      refusal,
      cursor,
      epoch: this.epoch(),
      inserted: 0,
      replayed: 0,
      updated: 0,
      corrected: 0,
      quarantined: 0,
      unindexed: 0,
      estimatedDirtyPages: 0,
      mergePossible,
      entries: [],
    };
  }

  private applyBatch(
    batch: CommitBatch,
    cursor: CursorUpdate,
    entries: readonly Entry[],
    placeholders: readonly OversizedPlaceholder[],
  ): Pick<
    CommitResult,
    | "inserted"
    | "replayed"
    | "updated"
    | "corrected"
    | "quarantined"
    | "entries"
  > {
    const nowMs = this.now();
    const { source } = batch;
    this.stmts.ensureSource.run(
      source.key,
      source.generation,
      source.discoveredAtMs,
    );
    const sourceRow = this.stmts.sourceRow.get(
      source.key,
      source.generation,
    ) as {
      id: bigint;
      first_discovery_ms: bigint;
    };
    const sourceId = sourceRow.id;
    const discoveryMs = sourceRow.first_discovery_ms;
    const stored = this.stmts.cursorGet.get(sourceId) as
      | { position: string }
      | undefined;
    if ((stored?.position ?? null) !== cursor.expected) {
      throw new CursorConflict("cursor does not match the persisted position");
    }

    const counters = new Map<bigint, bigint>();
    const allocate = (eventMs: bigint): bigint | null => {
      let next = counters.get(eventMs);
      if (next === undefined) {
        const row = this.stmts.counterGet.get(eventMs) as
          | { next_counter: bigint }
          | undefined;
        next = row ? row.next_counter : 0n;
      }
      if (next >= COUNTER_LIMIT) return null;
      counters.set(eventMs, next + 1n);
      return next;
    };

    const result = {
      inserted: 0,
      replayed: 0,
      updated: 0,
      corrected: 0,
      quarantined: 0,
      entries: [] as CommitEntry[],
    };
    let corrected = false;

    for (const entry of entries) {
      const { record } = entry;
      const dedupeKey = record.dedupeKey;
      let eventMs: bigint;
      let timeBasis: "event" | "discovery";
      const wholeMs =
        typeof record.eventTimeMs === "number" &&
        Number.isFinite(record.eventTimeMs)
          ? Math.floor(record.eventTimeMs)
          : null;
      if (isValidEventMs(wholeMs)) {
        eventMs = BigInt(wholeMs);
        timeBasis = "event";
      } else {
        eventMs = discoveryMs;
        timeBasis = "discovery";
      }
      if (entry.textBytes > this.limits.maxRecordTextBytes) {
        this.stmts.quarantineSet.run(
          sourceId,
          dedupeKey,
          "record_too_large",
          eventMs,
          nowMs,
          null,
          null,
          null,
        );
        result.quarantined += 1;
        result.entries.push({
          dedupeKey,
          outcome: "quarantined",
          rowid: null,
          timeBasis: null,
          reason: "record_too_large",
        });
        continue;
      }
      const existing = this.stmts.identityGet.get(dedupeKey) as
        | {
            content_id: bigint;
            event_ms: bigint;
            time_basis: "event" | "discovery";
          }
        | undefined;
      if (
        existing &&
        existing.event_ms === eventMs &&
        existing.time_basis === timeBasis
      ) {
        const same = this.stmts.contentSame.get(
          entry.text,
          entry.name ?? "",
          entry.callId ?? "",
          record.cwd ?? "",
          existing.content_id,
        ) as { same: number };
        if (same.same === 1) {
          result.replayed += 1;
          result.entries.push({
            dedupeKey,
            outcome: "replayed",
            rowid: serializeRowid(existing.content_id),
            timeBasis,
            reason: null,
          });
        } else {
          this.stmts.contentUpdate.run(
            entry.text,
            entry.name,
            entry.callId,
            record.cwd,
            existing.content_id,
          );
          this.writeTouches(existing.content_id, record);
          result.updated += 1;
          result.entries.push({
            dedupeKey,
            outcome: "updated",
            rowid: serializeRowid(existing.content_id),
            timeBasis,
            reason: null,
          });
        }
        continue;
      }
      const counter = allocate(eventMs);
      if (counter === null) {
        this.stmts.quarantineSet.run(
          sourceId,
          dedupeKey,
          "counter_overflow",
          eventMs,
          nowMs,
          null,
          null,
          null,
        );
        result.quarantined += 1;
        result.entries.push({
          dedupeKey,
          outcome: "quarantined",
          rowid: null,
          timeBasis: null,
          reason: "counter_overflow",
        });
        continue;
      }
      if (existing) {
        this.stmts.contentDelete.run(existing.content_id);
      }
      const rowid = composeRowid(eventMs, counter);
      this.stmts.contentInsert.run(
        rowid,
        sourceId,
        dedupeKey,
        record.kind,
        record.provider,
        record.sessionId,
        record.agentId,
        record.sidechain ? 1 : 0,
        entry.callId,
        entry.name,
        record.cwd,
        eventMs,
        timeBasis,
        entry.text,
      );
      this.stmts.identitySet.run(dedupeKey, rowid, sourceId);
      this.writeTouches(rowid, record);
      this.stmts.quarantineClear.run(dedupeKey);
      if (existing) {
        corrected = true;
        result.corrected += 1;
      } else {
        result.inserted += 1;
      }
      result.entries.push({
        dedupeKey,
        outcome: existing ? "corrected" : "inserted",
        rowid: serializeRowid(rowid),
        timeBasis,
        reason: null,
      });
    }

    for (const placeholder of placeholders) {
      this.stmts.quarantineSet.run(
        sourceId,
        placeholder.dedupeKey,
        placeholder.reason,
        null,
        nowMs,
        placeholder.startOffset,
        placeholder.endOffset,
        placeholder.byteLength,
      );
      result.quarantined += 1;
      result.entries.push({
        dedupeKey: placeholder.dedupeKey,
        outcome: "quarantined",
        rowid: null,
        timeBasis: null,
        reason: placeholder.reason,
      });
    }

    const orderedCounters = [...counters.entries()].sort((a, b) =>
      a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0,
    );
    for (const [eventMs, next] of orderedCounters) {
      this.stmts.counterSet.run(eventMs, next);
    }
    if (result.quarantined > 0) {
      this.stmts.quarantinePrune.run(this.limits.maxQuarantineRows);
    }
    if (corrected) this.stmts.epochBump.run();
    this.stmts.cursorSet.run(sourceId, cursor.next, nowMs);
    return result;
  }

  private writeTouches(contentId: bigint, record: SearchableRecord): void {
    this.stmts.touchDelete.run(contentId);
    if (record.kind !== "tool_call") return;
    for (const touch of record.touches) {
      this.stmts.touchInsert.run(
        contentId,
        touch.path,
        touch.access,
        touch.confidence,
      );
    }
  }
}

export interface ResetOptions extends OpenStoreOptions {
  confirm: true;
}

export function resetStore(
  dir: string,
  options: ResetOptions,
): { store: SessionSearchStore; diagnostics: ResetDiagnostics } {
  if ((options as { confirm?: unknown }).confirm !== true) {
    throw new StoreError(
      "confirmation_required",
      "reset-and-reingest discards the derived store and needs explicit confirmation",
    );
  }
  preparePrivateDirectory(dir);
  const dbPath = dbPathOf(dir);
  const diagnostics: ResetDiagnostics = {
    previousVersion: null,
    previousDbBytes: sizeOf(dbPath),
    previousSourceCount: null,
    previousContentCount: null,
    readError: null,
  };
  if (diagnostics.previousDbBytes > 0) {
    try {
      const probe = new Database(dbPath, {
        readonly: true,
        fileMustExist: true,
      });
      try {
        diagnostics.previousVersion = probe.pragma("user_version", {
          simple: true,
        }) as number;
        diagnostics.previousSourceCount = (
          probe
            .prepare("SELECT count(*) AS n FROM source_generation")
            .get() as {
            n: number;
          }
        ).n;
        diagnostics.previousContentCount = (
          probe.prepare("SELECT count(*) AS n FROM content").get() as {
            n: number;
          }
        ).n;
      } finally {
        probe.close();
      }
    } catch (error) {
      diagnostics.readError = (error as Error).message;
    }
  }
  removeDerivedFiles(dir);
  const store = openStore(dir, options);
  return { store, diagnostics };
}

function removeDerivedFiles(dir: string): void {
  const dbPath = dbPathOf(dir);
  for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    try {
      tightenPrivateFileIfPresent(path);
      rmFile(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const tmp = tmpDirOf(dir);
  preparePrivateDirectory(tmp);
  for (const name of readdirSync(tmp)) {
    const path = join(tmp, name);
    tightenPrivateFileIfPresent(path);
    rmFile(path);
  }
}

function rmFile(path: string): void {
  unlinkSync(path);
}
