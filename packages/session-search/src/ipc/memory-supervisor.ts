import {
  DEFAULT_MEMORY_POLICY,
  type MemoryAdmissionPolicy,
  type MemoryAdmissionProvider,
  type MemoryReservation,
  type MemorySample,
} from "../admission.js";
import type { KillResult } from "./framed-child.js";
import { readProcessMemory, type ProcessMemoryReader } from "./rss.js";

const MIB = 1024 * 1024;

export const DEFAULT_SUPERVISOR_LIMITS = {
  intervalMs: 100,
  staleAfterMs: 500,
  childSuspendBytes: 192 * MIB,
  childKillBytes: 256 * MIB,
  aggregateSuspendBytes: 640 * MIB,
  aggregateKillBytes: 768 * MIB,
  reservationBudgetBytes: 768 * MIB,
};

export type SupervisorLimits = typeof DEFAULT_SUPERVISOR_LIMITS;

export const SUPERVISED_MEMORY_POLICY: MemoryAdmissionPolicy = {
  ...DEFAULT_MEMORY_POLICY,
  maxSampleAgeMs: DEFAULT_SUPERVISOR_LIMITS.staleAfterMs,
};

export interface SupervisedProcess {
  readonly pid: number | undefined;
  readonly alive: boolean;
  readonly exited: Promise<unknown>;
  kill(): Promise<KillResult>;
}

export type KillReason = "child_rss" | "aggregate_rss";

export interface KillRecord {
  label: string;
  pid: number | undefined;
  reason: KillReason;
  rssBytes: number;
  thresholdBytes: number;
  sampledAtMs: number;
  detectedAtMs: number;
  reapLatencyMs: number | null;
  detectionToReapMs: number;
  peakRssBytes: number;
  osPeakRssBytes: number | null;
}

export interface ChildMemorySnapshot {
  label: string;
  pid: number | undefined;
  rssBytes: number | null;
  sampleAgeMs: number | null;
  suspended: boolean;
  killing: boolean;
  reservedBytes: number;
  samples: number;
  readFailures: number;
  identityMismatches: number;
  maxSampleGapMs: number;
  peakRssBytes: number;
  osPeakRssBytes: number | null;
  unreadable: boolean;
}

export interface MemorySupervisorSnapshot {
  aggregateRssBytes: number;
  aggregateSuspended: boolean;
  reservedBytes: number;
  unsupported: boolean;
  children: ChildMemorySnapshot[];
}

export interface MemorySupervisorOptions {
  limits?: Partial<SupervisorLimits>;
  clock?: () => number;
  readMemory?: ProcessMemoryReader;
  autoSample?: boolean;
  onKill?: (record: KillRecord) => void;
}

export interface WatchedEntry {
  readonly process: SupervisedProcess;
  readonly label: string;
  readonly watchedAtMs: number;
  readonly incarnation: string | null;
  readonly reservations: Set<ReservationHandle>;
  sample: MemorySample | null;
  lastSampledAtMs: number | null;
  samples: number;
  readFailures: number;
  identityMismatches: number;
  maxSampleGapMs: number;
  peakRssBytes: number;
  osPeakRssBytes: number | null;
  suspended: boolean;
  killing: boolean;
  closed: boolean;
  reservedBytes: number;
}

interface ReservationHandle extends MemoryReservation {
  readonly bytes: number;
}

function monotonicNow(): number {
  return Number(process.hrtime.bigint() / 1000n) / 1000;
}

export class WatchedChild {
  constructor(
    private readonly owner: MemorySupervisor,
    private readonly entry: WatchedEntry,
    readonly provider: MemoryAdmissionProvider,
  ) {}

  get label(): string {
    return this.entry.label;
  }

  snapshot(): ChildMemorySnapshot {
    return this.owner.describe(this.entry);
  }
}

export class MemorySupervisor {
  readonly limits: SupervisorLimits;

  private readonly clock: () => number;
  private readonly readMemory: ProcessMemoryReader;
  private readonly autoSample: boolean;
  private readonly onKill: ((record: KillRecord) => void) | undefined;
  private readonly entries = new Set<WatchedEntry>();
  private readonly retired: ChildMemorySnapshot[] = [];
  private readonly killRecords: KillRecord[] = [];
  private timer: NodeJS.Timeout | null = null;
  private reservedTotal = 0;
  private aggregateRssBytes = 0;
  private aggregateSuspended = false;
  private disposed = false;

  constructor(options: MemorySupervisorOptions = {}) {
    this.limits = { ...DEFAULT_SUPERVISOR_LIMITS, ...options.limits };
    this.clock = options.clock ?? monotonicNow;
    this.readMemory = options.readMemory ?? readProcessMemory;
    this.autoSample = options.autoSample ?? true;
    this.onKill = options.onKill;
  }

  watch(target: SupervisedProcess, label = "child"): WatchedChild {
    const watchedAtMs = this.clock();
    const pid = target.pid;
    const entry: WatchedEntry = {
      process: target,
      label,
      watchedAtMs,
      incarnation:
        pid === undefined ? null : (this.readMemory(pid)?.incarnation ?? null),
      reservations: new Set(),
      sample: null,
      lastSampledAtMs: null,
      samples: 0,
      readFailures: 0,
      identityMismatches: 0,
      maxSampleGapMs: 0,
      peakRssBytes: 0,
      osPeakRssBytes: null,
      suspended: false,
      killing: false,
      closed: false,
      reservedBytes: 0,
    };
    this.entries.add(entry);
    void target.exited.then(() => this.retire(entry));
    this.ensureTimer();
    return new WatchedChild(this, entry, this.providerFor(entry));
  }

  sampleNow(): void {
    const now = this.clock();
    const live: WatchedEntry[] = [];
    for (const entry of this.entries) {
      if (entry.closed || entry.killing || !entry.process.alive) continue;
      this.read(entry, now);
      live.push(entry);
    }
    const fresh = live.filter((entry) => this.isFresh(entry, now));
    for (const entry of live) {
      if (!fresh.includes(entry)) entry.suspended = true;
    }
    const remaining: WatchedEntry[] = [];
    for (const entry of fresh) {
      const rss = entry.sample?.rssBytes ?? 0;
      if (rss >= this.limits.childKillBytes) {
        this.terminate(entry, "child_rss", this.limits.childKillBytes);
        continue;
      }
      entry.suspended = rss >= this.limits.childSuspendBytes;
      remaining.push(entry);
    }
    let total = remaining.reduce(
      (sum, entry) => sum + (entry.sample?.rssBytes ?? 0),
      0,
    );
    while (total >= this.limits.aggregateKillBytes && remaining.length > 0) {
      let largest = 0;
      for (let index = 1; index < remaining.length; index += 1) {
        if (
          (remaining[index]?.sample?.rssBytes ?? 0) >
          (remaining[largest]?.sample?.rssBytes ?? 0)
        ) {
          largest = index;
        }
      }
      const [victim] = remaining.splice(largest, 1);
      if (victim === undefined) break;
      total -= victim.sample?.rssBytes ?? 0;
      this.terminate(victim, "aggregate_rss", this.limits.aggregateKillBytes);
    }
    this.aggregateRssBytes = total;
    this.aggregateSuspended = total >= this.limits.aggregateSuspendBytes;
  }

  snapshot(): MemorySupervisorSnapshot {
    const children = [...this.entries].map((entry) => this.describe(entry));
    return {
      aggregateRssBytes: this.aggregateRssBytes,
      aggregateSuspended: this.aggregateSuspended,
      reservedBytes: this.reservedTotal,
      unsupported: children.some((child) => child.unreadable),
      children,
    };
  }

  retiredChildren(): ChildMemorySnapshot[] {
    return [...this.retired];
  }

  kills(): KillRecord[] {
    return [...this.killRecords];
  }

  reservedBytes(): number {
    return this.reservedTotal;
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  describe(entry: WatchedEntry): ChildMemorySnapshot {
    const now = this.clock();
    return {
      label: entry.label,
      pid: entry.process.pid,
      rssBytes: entry.sample?.rssBytes ?? null,
      sampleAgeMs:
        entry.sample === null ? null : now - entry.sample.sampledAtMs,
      suspended: entry.suspended,
      killing: entry.killing,
      reservedBytes: entry.reservedBytes,
      samples: entry.samples,
      readFailures: entry.readFailures,
      identityMismatches: entry.identityMismatches,
      maxSampleGapMs: entry.maxSampleGapMs,
      peakRssBytes: entry.peakRssBytes,
      osPeakRssBytes: entry.osPeakRssBytes,
      unreadable:
        !entry.closed &&
        !this.isFresh(entry, now) &&
        now - (entry.lastSampledAtMs ?? entry.watchedAtMs) >
          this.limits.staleAfterMs,
    };
  }

  private providerFor(entry: WatchedEntry): MemoryAdmissionProvider {
    return {
      clock: () => this.clock(),
      sample: () => {
        if (entry.closed || !entry.process.alive) return null;
        if (entry.sample === null) return null;
        if (!this.isFresh(entry, this.clock())) return null;
        return { ...entry.sample };
      },
      acquire: (bytes) => this.acquire(entry, bytes),
    };
  }

  private acquire(entry: WatchedEntry, bytes: number): MemoryReservation | null {
    if (!Number.isFinite(bytes) || bytes < 0) return null;
    if (entry.closed || entry.killing || this.disposed) return null;
    if (!entry.process.alive) return null;
    const now = this.clock();
    if (!this.isFresh(entry, now) || entry.sample === null) return null;
    if (entry.sample.rssBytes >= this.limits.childSuspendBytes) return null;
    if (this.aggregateSuspended) return null;
    if (this.reservedTotal + bytes > this.limits.reservationBudgetBytes) {
      return null;
    }
    let released = false;
    const handle: ReservationHandle = {
      bytes,
      release: () => {
        if (released) return;
        released = true;
        entry.reservations.delete(handle);
        entry.reservedBytes -= bytes;
        this.reservedTotal -= bytes;
      },
    };
    entry.reservations.add(handle);
    entry.reservedBytes += bytes;
    this.reservedTotal += bytes;
    return handle;
  }

  private isFresh(entry: WatchedEntry, now: number): boolean {
    if (entry.sample === null) return false;
    const age = now - entry.sample.sampledAtMs;
    return age >= 0 && age <= this.limits.staleAfterMs;
  }

  private read(entry: WatchedEntry, now: number): void {
    const pid = entry.process.pid;
    const memory = pid === undefined ? null : this.readMemory(pid);
    if (memory === null) {
      entry.readFailures += 1;
      entry.sample = null;
      return;
    }
    if ((memory.incarnation ?? null) !== entry.incarnation) {
      entry.readFailures += 1;
      entry.identityMismatches += 1;
      entry.sample = null;
      return;
    }
    if (entry.lastSampledAtMs !== null) {
      entry.maxSampleGapMs = Math.max(
        entry.maxSampleGapMs,
        now - entry.lastSampledAtMs,
      );
    }
    entry.sample = { rssBytes: memory.rssBytes, sampledAtMs: now };
    entry.lastSampledAtMs = now;
    entry.samples += 1;
    entry.peakRssBytes = Math.max(entry.peakRssBytes, memory.rssBytes);
    if (memory.peakRssBytes !== null) {
      entry.osPeakRssBytes = Math.max(
        entry.osPeakRssBytes ?? 0,
        memory.peakRssBytes,
      );
    }
  }

  private terminate(
    entry: WatchedEntry,
    reason: KillReason,
    thresholdBytes: number,
  ): void {
    if (entry.killing) return;
    entry.killing = true;
    entry.suspended = true;
    const detectedAtMs = this.clock();
    const rssBytes = entry.sample?.rssBytes ?? 0;
    const sampledAtMs = entry.sample?.sampledAtMs ?? detectedAtMs;
    void entry.process.kill().then((result) => {
      const record: KillRecord = {
        label: entry.label,
        pid: entry.process.pid,
        reason,
        rssBytes,
        thresholdBytes,
        sampledAtMs,
        detectedAtMs,
        reapLatencyMs: result.alreadyExited ? null : result.reapLatencyMs,
        detectionToReapMs: this.clock() - detectedAtMs,
        peakRssBytes: entry.peakRssBytes,
        osPeakRssBytes: entry.osPeakRssBytes,
      };
      this.killRecords.push(record);
      this.onKill?.(record);
    });
  }

  private retire(entry: WatchedEntry): void {
    for (const reservation of [...entry.reservations]) reservation.release();
    entry.closed = true;
    this.retired.push(this.describe(entry));
    this.entries.delete(entry);
  }

  private ensureTimer(): void {
    if (!this.autoSample || this.disposed || this.timer !== null) return;
    if (this.entries.size === 0) return;
    this.timer = setTimeout(this.tick, this.limits.intervalMs);
    this.timer.unref();
  }

  private readonly tick = (): void => {
    this.timer = null;
    this.sampleNow();
    this.ensureTimer();
  };
}
