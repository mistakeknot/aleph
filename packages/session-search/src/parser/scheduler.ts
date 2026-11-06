import type { PageBudget } from "../adapters/jsonl-page.js";
import type {
  CommitBatch,
  CommitResult,
  CursorUpdate,
  SourceRef,
} from "../storage.js";
import type { ParserHandle, ParserOutcome } from "./parser-process.js";
import { pageBindingViolation, type ParserSourceSpec } from "./protocol.js";

export const DEFAULT_QUANTUM_MS = 2_000;

export type CommitFence = () => boolean;

export interface CommitSink {
  cursor(ref: SourceRef): string | null | Promise<string | null>;
  commit(
    batch: CommitBatch,
    update: CursorUpdate,
    fence: CommitFence,
  ): CommitResult | Promise<CommitResult>;
}

export function storeSink(store: {
  getCursor(source: SourceRef): string | null;
  commitBatch(
    batch: CommitBatch,
    cursor: CursorUpdate,
    fence?: CommitFence,
  ): CommitResult;
}): CommitSink {
  return {
    cursor: (ref) => store.getCursor(ref),
    commit: (batch, update, fence) => store.commitBatch(batch, update, fence),
  };
}

export type SourceStatus =
  | "ready"
  | "running"
  | "idle"
  | "unreadable"
  | "invalidated"
  | "quarantined"
  | "suspended"
  | "deferred";

export interface SourceState {
  spec: ParserSourceSpec;
  status: SourceStatus;
  cursor: string | null;
  reason: string | null;
  notBeforeMs: number;
  pagesCommitted: number;
  turns: number;
  consecutiveTerminations: number;
}

export type SchedulerEventType =
  | "committed"
  | "yield"
  | "idle"
  | "unreadable"
  | "invalidated"
  | "quarantined"
  | "suspended"
  | "retry"
  | "deferred";

export interface SchedulerEvent {
  type: SchedulerEventType;
  key: string;
  generation: number;
  detail: string;
}

export interface SchedulerOptions {
  parsers: readonly ParserHandle[];
  sink: CommitSink;
  clock: () => number;
  quantumMs?: number;
  stallMs?: number;
  pageBudget?: PageBudget;
  unreadableBackoffMs?: number;
  unreadableBackoffMaxMs?: number;
  deferBackoffMs?: number;
  restartBackoffMs?: number;
  restartBackoffMaxMs?: number;
  maxTerminations?: number;
  maxCursorConflicts?: number;
  maxSinkFailures?: number;
  onEvent?: (event: SchedulerEvent) => void;
}

interface Entry extends SourceState {
  cursorKnown: boolean;
  sequence: number;
  unreadableStreak: number;
  conflicts: number;
  cursorFailures: number;
  commitFailures: number;
}

const RUNNABLE: ReadonlySet<SourceStatus> = new Set([
  "ready",
  "deferred",
  "unreadable",
]);

export class ParserScheduler {
  private readonly entries = new Map<string, Entry>();
  private readonly quantumMs: number;
  private readonly stallMs: number;
  private readonly unreadableBackoffMs: number;
  private readonly unreadableBackoffMaxMs: number;
  private readonly deferBackoffMs: number;
  private readonly restartBackoffMs: number;
  private readonly restartBackoffMaxMs: number;
  private readonly commitChains = new Map<string, Promise<unknown>>();
  private readonly maxTerminations: number;
  private readonly maxCursorConflicts: number;
  private readonly maxSinkFailures: number;
  private sequence = 0;
  private active = 0;
  private draining: Promise<void> | null = null;
  private wakers: Array<() => void> = [];

  constructor(private readonly options: SchedulerOptions) {
    this.quantumMs = options.quantumMs ?? DEFAULT_QUANTUM_MS;
    this.stallMs = options.stallMs ?? this.quantumMs;
    this.unreadableBackoffMs = options.unreadableBackoffMs ?? 1_000;
    this.unreadableBackoffMaxMs = options.unreadableBackoffMaxMs ?? 60_000;
    this.deferBackoffMs = options.deferBackoffMs ?? 500;
    this.restartBackoffMs = options.restartBackoffMs ?? 250;
    this.restartBackoffMaxMs = options.restartBackoffMaxMs ?? 10_000;
    this.maxTerminations = options.maxTerminations ?? 2;
    this.maxCursorConflicts = options.maxCursorConflicts ?? 3;
    this.maxSinkFailures = options.maxSinkFailures ?? 5;
  }

  upsert(spec: ParserSourceSpec): void {
    const existing = this.entries.get(spec.ref.key);
    if (
      existing !== undefined &&
      existing.spec.ref.generation === spec.ref.generation
    ) {
      existing.spec = spec;
      return;
    }
    this.entries.set(spec.ref.key, {
      spec,
      status: "ready",
      cursor: null,
      reason: null,
      notBeforeMs: 0,
      pagesCommitted: 0,
      turns: 0,
      consecutiveTerminations: 0,
      cursorKnown: false,
      sequence: this.sequence++,
      unreadableStreak: 0,
      conflicts: 0,
      cursorFailures: 0,
      commitFailures: 0,
    });
  }

  remove(key: string): void {
    this.entries.delete(key);
  }

  notify(key: string): void {
    const entry = this.entries.get(key);
    if (entry !== undefined && entry.status === "idle") {
      entry.status = "ready";
      entry.sequence = this.sequence++;
    }
  }

  state(key: string): SourceState | null {
    const entry = this.entries.get(key);
    return entry === undefined ? null : this.view(entry);
  }

  states(): SourceState[] {
    return [...this.entries.values()].map((entry) => this.view(entry));
  }

  nextWakeAtMs(): number | null {
    let wake: number | null = null;
    for (const entry of this.entries.values()) {
      if (!RUNNABLE.has(entry.status)) continue;
      if (wake === null || entry.notBeforeMs < wake) wake = entry.notBeforeMs;
    }
    return wake;
  }

  drain(): Promise<void> {
    if (this.draining === null) {
      this.draining = Promise.all(
        this.options.parsers.map((parser) => this.worker(parser)),
      ).then(
        () => {
          this.draining = null;
        },
        (error) => {
          this.draining = null;
          throw error;
        },
      );
    }
    return this.draining;
  }

  private view(entry: Entry): SourceState {
    return {
      spec: entry.spec,
      status: entry.status,
      cursor: entry.cursor,
      reason: entry.reason,
      notBeforeMs: entry.notBeforeMs,
      pagesCommitted: entry.pagesCommitted,
      turns: entry.turns,
      consecutiveTerminations: entry.consecutiveTerminations,
    };
  }

  private emit(entry: Entry, type: SchedulerEventType, detail: string): void {
    this.options.onEvent?.({
      type,
      key: entry.spec.ref.key,
      generation: entry.spec.ref.generation,
      detail,
    });
  }

  private pick(): Entry | null {
    const now = this.options.clock();
    let best: Entry | null = null;
    for (const entry of this.entries.values()) {
      if (!RUNNABLE.has(entry.status) || entry.notBeforeMs > now) continue;
      if (best === null || entry.sequence < best.sequence) best = entry;
    }
    return best;
  }

  private wake(): void {
    const wakers = this.wakers;
    this.wakers = [];
    for (const waker of wakers) waker();
  }

  private async worker(parser: ParserHandle): Promise<void> {
    for (;;) {
      const entry = this.pick();
      if (entry === null) {
        if (this.active === 0) return;
        await new Promise<void>((resolve) => this.wakers.push(resolve));
        continue;
      }
      entry.status = "running";
      this.active += 1;
      try {
        await this.turn(parser, entry);
      } finally {
        this.active -= 1;
        this.wake();
      }
    }
  }

  private current(entry: Entry): boolean {
    return this.entries.get(entry.spec.ref.key) === entry;
  }

  private requeue(
    entry: Entry,
    status: SourceStatus,
    notBeforeMs: number,
  ): void {
    entry.status = status;
    entry.notBeforeMs = notBeforeMs;
    entry.sequence = this.sequence++;
  }

  private defer(entry: Entry, reason: string, delayMs?: number): void {
    entry.reason = reason;
    this.requeue(
      entry,
      "deferred",
      this.options.clock() + (delayMs ?? this.deferBackoffMs),
    );
    this.emit(entry, "deferred", reason);
  }

  private sinkFailed(
    entry: Entry,
    stage: "cursor" | "commit",
    error: unknown,
  ): void {
    const message = error instanceof Error ? error.message : String(error);
    const failures =
      stage === "cursor" ? ++entry.cursorFailures : ++entry.commitFailures;
    if (failures >= this.maxSinkFailures) {
      this.quarantine(
        entry,
        `${stage}_failed: ${failures} consecutive failures: ${message}`,
      );
      return;
    }
    this.defer(entry, message, this.deferBackoffMs * 2 ** (failures - 1));
  }

  private commitSerialized(
    entry: Entry,
    batch: CommitBatch,
    update: CursorUpdate,
  ): Promise<CommitResult | null> {
    const key = entry.spec.ref.key;
    const previous = this.commitChains.get(key) ?? Promise.resolve();
    const run = previous.then(async (): Promise<CommitResult | null> => {
      if (!this.current(entry)) return null;
      return await this.options.sink.commit(batch, update, () =>
        this.current(entry),
      );
    });
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.commitChains.set(key, tail);
    void tail.then(() => {
      if (this.commitChains.get(key) === tail) this.commitChains.delete(key);
    });
    return run;
  }

  private quarantine(entry: Entry, reason: string): void {
    entry.status = "quarantined";
    entry.reason = reason;
    this.emit(entry, "quarantined", reason);
  }

  private async turn(parser: ParserHandle, entry: Entry): Promise<void> {
    const start = this.options.clock();
    entry.turns += 1;
    for (;;) {
      if (!entry.cursorKnown) {
        let stored: string | null;
        try {
          stored = await this.options.sink.cursor(entry.spec.ref);
        } catch (error) {
          if (!this.current(entry)) return;
          this.sinkFailed(entry, "cursor", error);
          return;
        }
        if (!this.current(entry)) return;
        entry.cursorFailures = 0;
        entry.cursor = stored;
        entry.cursorKnown = true;
      }
      let outcome: ParserOutcome;
      try {
        outcome = await parser.read({
          source: entry.spec,
          cursor: entry.cursor,
          budget: this.options.pageBudget,
          stallMs: this.stallMs,
        });
      } catch (error) {
        outcome = {
          kind: "terminated",
          cause: "crash",
          message: error instanceof Error ? error.message : String(error),
        };
      }
      if (!this.current(entry)) return;
      const next = await this.apply(entry, outcome);
      if (!this.current(entry)) return;
      if (next === "stop") return;
      if (this.options.clock() - start >= this.quantumMs) {
        this.emit(entry, "yield", `quantum of ${this.quantumMs} ms used`);
        this.requeue(entry, "ready", 0);
        return;
      }
    }
  }

  private async apply(
    entry: Entry,
    outcome: ParserOutcome,
  ): Promise<"continue" | "stop"> {
    const now = this.options.clock();
    switch (outcome.kind) {
      case "page": {
        entry.consecutiveTerminations = 0;
        entry.unreadableStreak = 0;
        const page = outcome.page;
        if (page.status === "idle") {
          entry.status = "idle";
          this.emit(entry, "idle", "no new data");
          return "stop";
        }
        if (page.status === "invalidated") {
          entry.status = "invalidated";
          entry.reason = page.reason;
          this.emit(entry, "invalidated", page.reason);
          return "stop";
        }
        const violation = pageBindingViolation(
          page,
          entry.spec.ref,
          entry.cursor,
        );
        if (violation !== null) {
          this.quarantine(entry, `protocol_violation: ${violation}`);
          return "stop";
        }
        let result: CommitResult | null;
        try {
          result = await this.commitSerialized(entry, page.batch, page.cursor);
        } catch (error) {
          if (!this.current(entry)) return "stop";
          this.sinkFailed(entry, "commit", error);
          return "stop";
        }
        if (result === null || !this.current(entry)) return "stop";
        entry.commitFailures = 0;
        if (result.committed) {
          entry.cursor = page.cursor.next;
          entry.conflicts = 0;
          entry.pagesCommitted += 1;
          this.emit(entry, "committed", page.cursor.next);
          if (page.progress.endOfFile) {
            entry.status = "idle";
            this.emit(entry, "idle", "end of file");
            return "stop";
          }
          return "continue";
        }
        const refusal = result.refusal;
        const code = refusal?.code ?? "cursor_conflict";
        if (code === "cursor_conflict") {
          entry.cursorKnown = false;
          entry.conflicts += 1;
          if (entry.conflicts < this.maxCursorConflicts) return "continue";
          entry.conflicts = 0;
        } else if (code === "invalid_batch" || code === "batch_too_large") {
          this.quarantine(entry, `${code}: ${refusal?.message ?? ""}`);
          return "stop";
        }
        this.defer(entry, `${code}: ${refusal?.message ?? ""}`);
        return "stop";
      }
      case "error": {
        if (outcome.code === "unreadable") {
          entry.unreadableStreak += 1;
          const backoff = Math.min(
            this.unreadableBackoffMs * 2 ** (entry.unreadableStreak - 1),
            this.unreadableBackoffMaxMs,
          );
          entry.reason = outcome.message;
          this.requeue(entry, "unreadable", now + backoff);
          this.emit(entry, "unreadable", outcome.message);
          return "stop";
        }
        this.quarantine(entry, `${outcome.code}: ${outcome.message}`);
        return "stop";
      }
      case "refused": {
        this.defer(entry, outcome.message);
        return "stop";
      }
      case "stalled": {
        this.quarantine(entry, `stalled: ${outcome.message}`);
        return "stop";
      }
      case "terminated": {
        if (outcome.cause === "protocol_violation") {
          this.quarantine(entry, outcome.message);
          return "stop";
        }
        entry.consecutiveTerminations += 1;
        entry.reason = outcome.message;
        if (entry.consecutiveTerminations >= this.maxTerminations) {
          entry.status = "suspended";
          this.emit(
            entry,
            "suspended",
            `${entry.consecutiveTerminations} consecutive terminations: ${outcome.message}`,
          );
          return "stop";
        }
        const restartDelay = Math.min(
          this.restartBackoffMs * 2 ** (entry.consecutiveTerminations - 1),
          this.restartBackoffMaxMs,
        );
        this.requeue(entry, "ready", now + restartDelay);
        this.emit(entry, "retry", outcome.message);
        return "stop";
      }
    }
  }
}
