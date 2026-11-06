import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  admitMemory,
  FramedChild,
  MemorySupervisor,
  osRssSupported,
  readProcessMemory,
  SUPERVISED_MEMORY_POLICY,
  type KillRecord,
  type SupervisorLimits,
  type WatchedChild,
} from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const packageDir = join(here, "..");
const childScript = join(here, "support", "rss-child.ts");
const MIB = 1024 * 1024;
const supported = osRssSupported();

if (!supported) {
  process.stderr.write(
    `[rss-supervisor] NOT RUN: OS RSS reading is unavailable on ${process.platform}\n`,
  );
}

interface Launched {
  child: FramedChild;
  ready: Promise<void>;
}

const children: FramedChild[] = [];
const supervisors: MemorySupervisor[] = [];

afterEach(async () => {
  for (const supervisor of supervisors.splice(0)) supervisor.dispose();
  await Promise.all(children.splice(0).map((child) => child.kill()));
});

function launch(mode: string, mib = 0): Launched {
  let resolveReady!: () => void;
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });
  const child = new FramedChild({
    args: ["--import", "tsx", childScript, mode, String(mib)],
    cwd: packageDir,
    onFrame: (payload) => {
      if (payload.toString() === "ready") resolveReady();
    },
  });
  children.push(child);
  return { child, ready };
}

function supervise(
  limits: Partial<SupervisorLimits>,
  options: { autoSample?: boolean } = {},
): { supervisor: MemorySupervisor; kills: KillRecord[] } {
  const kills: KillRecord[] = [];
  const supervisor = new MemorySupervisor({
    limits,
    autoSample: options.autoSample,
    onKill: (record) => kills.push(record),
  });
  supervisors.push(supervisor);
  return { supervisor, kills };
}

async function until(
  predicate: () => boolean,
  timeoutMs: number,
  what: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function report(name: string, fields: Record<string, unknown>): void {
  process.stderr.write(
    `[rss-supervisor] ${JSON.stringify({ test: name, ...fields })}\n`,
  );
}

function mib(bytes: number | null): number | null {
  return bytes === null ? null : Math.round((bytes / MIB) * 10) / 10;
}

function killFields(
  record: KillRecord,
  watched: WatchedChild,
  baseline: number,
): Record<string, unknown> {
  const snapshot = watched.snapshot();
  return {
    reason: record.reason,
    baselineMiB: mib(baseline),
    thresholdMiB: mib(record.thresholdBytes),
    rssAtDetectionMiB: mib(record.rssBytes),
    sampledPeakMiB: mib(record.peakRssBytes),
    osPeakMiB: mib(record.osPeakRssBytes),
    sampledOvershootMiB: mib(
      Math.max(0, record.peakRssBytes - record.thresholdBytes),
    ),
    osOvershootMiB: mib(
      Math.max(0, (record.osPeakRssBytes ?? 0) - record.thresholdBytes),
    ),
    samples: snapshot.samples,
    maxSampleGapMs: Math.round(snapshot.maxSampleGapMs * 10) / 10,
    killToReapMs: record.reapLatencyMs,
    detectionToReapMs: Math.round(record.detectionToReapMs * 10) / 10,
  };
}

const HIGH = 4096 * MIB;

describe.skipIf(!supported)(
  "memory supervisor with real child processes",
  () => {
    let baseline = 0;

    beforeAll(async () => {
      const { child, ready } = launch("idle");
      await ready;
      await new Promise((resolve) => setTimeout(resolve, 300));
      const memory = readProcessMemory(child.pid ?? 0);
      expect(memory).not.toBeNull();
      baseline = memory?.rssBytes ?? 0;
      report("baseline", { idleChildRssMiB: mib(baseline) });
      await child.kill();
    });

    afterAll(() => {
      expect(baseline).toBeGreaterThan(0);
    });

    it("reads the real resident size of a child that holds native allocations", async () => {
      const { child, ready } = launch("hold", 64);
      await ready;
      const memory = readProcessMemory(child.pid ?? 0);
      expect(memory).not.toBeNull();
      expect(memory?.rssBytes ?? 0).toBeGreaterThan(baseline + 48 * MIB);
      expect(memory?.peakRssBytes ?? 0).toBeGreaterThanOrEqual(
        memory?.rssBytes ?? 0,
      );
      expect(memory?.incarnation).toMatch(/^\d+$/);
      expect(readProcessMemory(child.pid ?? 0)?.incarnation).toBe(
        memory?.incarnation,
      );
      expect(readProcessMemory(process.pid)?.incarnation).not.toBe(
        memory?.incarnation,
      );
    }, 20_000);

    it("suspends admission above the per-child suspend line without killing", async () => {
      const { supervisor, kills } = supervise({
        childSuspendBytes: baseline + 32 * MIB,
        childKillBytes: baseline + 160 * MIB,
        aggregateSuspendBytes: HIGH,
        aggregateKillBytes: HIGH,
      });
      const { child, ready } = launch("hold", 56);
      const watched = supervisor.watch(child, "suspend");
      await ready;
      await until(
        () => watched.snapshot().suspended,
        5000,
        "child to be suspended",
      );
      expect(
        watched.provider.acquire(SUPERVISED_MEMORY_POLICY.minReservationBytes),
      ).toBeNull();
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(kills).toHaveLength(0);
      expect(child.alive).toBe(true);
      report("suspend-without-kill", {
        baselineMiB: mib(baseline),
        suspendLineMiB: mib(baseline + 32 * MIB),
        rssMiB: mib(watched.snapshot().rssBytes),
      });
    }, 20_000);

    it("kills a child that grows past the per-child kill line and releases its reservation", async () => {
      const killLine = baseline + 64 * MIB;
      const { supervisor, kills } = supervise({
        childSuspendBytes: baseline + 32 * MIB,
        childKillBytes: killLine,
        aggregateSuspendBytes: HIGH,
        aggregateKillBytes: HIGH,
      });
      const { child, ready } = launch("grow", 192);
      const watched = supervisor.watch(child, "grow");
      await ready;
      await until(
        () => watched.snapshot().samples > 0,
        3000,
        "first RSS sample",
      );
      const reservation = watched.provider.acquire(
        SUPERVISED_MEMORY_POLICY.minReservationBytes,
      );
      expect(reservation).not.toBeNull();
      expect(supervisor.reservedBytes()).toBe(
        SUPERVISED_MEMORY_POLICY.minReservationBytes,
      );
      expect(watched.snapshot().rssBytes ?? 0).toBeLessThan(
        baseline + 32 * MIB,
      );
      await child.send(Buffer.from("go"));
      await until(() => kills.length === 1, 10_000, "kill record");
      const record = kills[0] as KillRecord;
      expect(record.reason).toBe("child_rss");
      expect(record.rssBytes).toBeGreaterThanOrEqual(killLine);
      expect(record.detectionToReapMs).toBeLessThan(1000);
      expect(record.reapLatencyMs).not.toBeNull();
      expect(record.reapLatencyMs ?? 0).toBeLessThan(1000);
      const exit = await child.exited;
      expect(exit.cause).toBe("killed");
      expect(exit.signal).toBe("SIGKILL");
      expect(supervisor.reservedBytes()).toBe(0);
      expect(watched.provider.acquire(1)).toBeNull();
      report("kill-event-loop-live", killFields(record, watched, baseline));
    }, 30_000);

    it("kills a child whose event loop is blocked in synchronous work", async () => {
      const killLine = baseline + 64 * MIB;
      const { supervisor, kills } = supervise({
        childSuspendBytes: baseline + 32 * MIB,
        childKillBytes: killLine,
        aggregateSuspendBytes: HIGH,
        aggregateKillBytes: HIGH,
      });
      const { child, ready } = launch("sync-grow", 192);
      const watched = supervisor.watch(child, "blocked");
      await ready;
      await until(
        () => watched.snapshot().samples > 0,
        3000,
        "first RSS sample",
      );
      expect(watched.snapshot().rssBytes ?? 0).toBeLessThan(
        baseline + 32 * MIB,
      );
      await child.send(Buffer.from("go"));
      await until(() => kills.length === 1, 10_000, "kill record");
      const record = kills[0] as KillRecord;
      expect(record.reason).toBe("child_rss");
      expect(record.rssBytes).toBeGreaterThanOrEqual(killLine);
      expect(record.detectionToReapMs).toBeLessThan(1000);
      const exit = await child.exited;
      expect(exit.signal).toBe("SIGKILL");
      expect(supervisor.reservedBytes()).toBe(0);
      report("kill-event-loop-blocked", killFields(record, watched, baseline));
    }, 30_000);

    it("keeps killing a child that never yields the event loop", async () => {
      const { supervisor, kills } = supervise({
        childSuspendBytes: baseline + 16 * MIB,
        childKillBytes: baseline + 48 * MIB,
        aggregateSuspendBytes: HIGH,
        aggregateKillBytes: HIGH,
      });
      const { child, ready } = launch("spin");
      const watched = supervisor.watch(child, "spin");
      await ready;
      await until(
        () => watched.snapshot().samples >= 3,
        3000,
        "samples from a spinning child",
      );
      expect(watched.snapshot().rssBytes ?? 0).toBeLessThan(
        baseline + 48 * MIB,
      );
      expect(kills).toHaveLength(0);
      const reaped = await child.kill();
      expect(reaped.alreadyExited).toBe(false);
      expect(reaped.reapLatencyMs).toBeLessThan(1000);
      await until(
        () => supervisor.retiredChildren().length === 1,
        3000,
        "retirement",
      );
    }, 20_000);

    it("refuses admission when the sample is absent or stale, never bypassing", async () => {
      const { supervisor } = supervise({}, { autoSample: false });
      const { child, ready } = launch("idle");
      const watched = supervisor.watch(child, "stale");
      await ready;
      expect(watched.provider.sample()).toBeNull();
      const absent = admitMemory(watched.provider, SUPERVISED_MEMORY_POLICY, 0);
      expect(absent.ok).toBe(false);
      expect(watched.provider.acquire(1)).toBeNull();

      supervisor.sampleNow();
      const fresh = admitMemory(watched.provider, SUPERVISED_MEMORY_POLICY, 0);
      expect(fresh.ok).toBe(true);
      if (fresh.ok) fresh.reservation.release();

      await new Promise((resolve) => setTimeout(resolve, 650));
      expect(watched.provider.sample()).toBeNull();
      const stale = admitMemory(watched.provider, SUPERVISED_MEMORY_POLICY, 0);
      expect(stale.ok).toBe(false);
      expect(watched.provider.acquire(1)).toBeNull();
      expect(supervisor.reservedBytes()).toBe(0);

      supervisor.sampleNow();
      const again = admitMemory(watched.provider, SUPERVISED_MEMORY_POLICY, 0);
      expect(again.ok).toBe(true);
      if (again.ok) again.reservation.release();
    }, 20_000);

    it("releases reservations when a child exits on its own", async () => {
      const { supervisor } = supervise({});
      const { child, ready } = launch("idle");
      const watched = supervisor.watch(child, "exit");
      await ready;
      await until(
        () => watched.snapshot().samples > 0,
        3000,
        "first RSS sample",
      );
      const reservation = watched.provider.acquire(64 * MIB);
      expect(reservation).not.toBeNull();
      expect(supervisor.reservedBytes()).toBe(64 * MIB);
      const closing = await child.close(2000);
      expect(closing.cause).toBe("exited");
      await until(
        () => supervisor.reservedBytes() === 0,
        3000,
        "reservation release on exit",
      );
      reservation?.release();
      expect(supervisor.reservedBytes()).toBe(0);
    }, 20_000);

    it("kills the largest child when summed RSS crosses the aggregate kill line", async () => {
      const { supervisor, kills } = supervise({
        childSuspendBytes: HIGH,
        childKillBytes: HIGH,
        aggregateSuspendBytes: 2 * baseline + 40 * MIB,
        aggregateKillBytes: 2 * baseline + 100 * MIB,
      });
      const first = launch("hold", 96);
      const second = launch("hold", 96);
      supervisor.watch(first.child, "first");
      supervisor.watch(second.child, "second");
      await until(() => kills.length === 1, 10_000, "aggregate kill");
      const record = kills[0] as KillRecord;
      expect(record.reason).toBe("aggregate_rss");
      expect(record.detectionToReapMs).toBeLessThan(1000);
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(kills).toHaveLength(1);
      const alive = [first.child, second.child].filter((child) => child.alive);
      expect(alive).toHaveLength(1);
      report("kill-aggregate", {
        baselineMiB: mib(baseline),
        thresholdMiB: mib(record.thresholdBytes),
        rssAtDetectionMiB: mib(record.rssBytes),
        victim: record.label,
        detectionToReapMs: Math.round(record.detectionToReapMs * 10) / 10,
        killToReapMs: record.reapLatencyMs,
      });
    }, 30_000);
  },
);
