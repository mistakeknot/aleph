import { describe, expect, it } from "vitest";

import { admitMemory } from "../src/admission.js";
import {
  DEFAULT_SUPERVISOR_LIMITS,
  MemorySupervisor,
  SUPERVISED_MEMORY_POLICY,
  type SupervisedProcess,
} from "../src/ipc/memory-supervisor.js";
import { parseProcStatus } from "../src/ipc/rss.js";

const MIB = 1024 * 1024;

class FakeChild implements SupervisedProcess {
  alive = true;
  killCalls = 0;
  readonly exited: Promise<unknown>;
  private finish!: () => void;

  constructor(readonly pid: number) {
    this.exited = new Promise((resolve) => {
      this.finish = () => resolve(undefined);
    });
  }

  async kill() {
    this.killCalls += 1;
    this.alive = false;
    this.finish();
    return { alreadyExited: false, reapLatencyMs: 3 };
  }

  exit(): void {
    this.alive = false;
    this.finish();
  }
}

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function harness() {
  let now = 1000;
  const rss = new Map<number, number>();
  const supervisor = new MemorySupervisor({
    clock: () => now,
    autoSample: false,
    readMemory: (pid) => {
      const value = rss.get(pid);
      return value === undefined
        ? null
        : { rssBytes: value, peakRssBytes: value };
    },
  });
  let nextPid = 100;
  return {
    supervisor,
    rss,
    advance: (ms: number) => {
      now += ms;
    },
    spawn: (label: string, bytes: number | null) => {
      const child = new FakeChild(nextPid);
      nextPid += 1;
      if (bytes !== null) rss.set(child.pid, bytes);
      return { child, watch: supervisor.watch(child, label) };
    },
  };
}

describe("memory supervisor arithmetic", () => {
  it("uses the documented default limits", () => {
    expect(DEFAULT_SUPERVISOR_LIMITS).toEqual({
      intervalMs: 100,
      staleAfterMs: 500,
      childSuspendBytes: 192 * MIB,
      childKillBytes: 256 * MIB,
      aggregateSuspendBytes: 640 * MIB,
      aggregateKillBytes: 768 * MIB,
      reservationBudgetBytes: 768 * MIB,
    });
    expect(SUPERVISED_MEMORY_POLICY.maxSampleAgeMs).toBe(500);
  });

  it("refuses admission while no sample exists", () => {
    const h = harness();
    const { watch } = h.spawn("a", 10 * MIB);
    expect(watch.provider.sample()).toBeNull();
    const admission = admitMemory(watch.provider, SUPERVISED_MEMORY_POLICY, 0);
    expect(admission.ok).toBe(false);
    expect(h.supervisor.reservedBytes()).toBe(0);
  });

  it("admits on a fresh sample and releases the reservation", () => {
    const h = harness();
    const { watch } = h.spawn("a", 10 * MIB);
    h.supervisor.sampleNow();
    const admission = admitMemory(
      watch.provider,
      SUPERVISED_MEMORY_POLICY,
      MIB,
    );
    expect(admission.ok).toBe(true);
    if (!admission.ok) return;
    expect(admission.reservedBytes).toBe(34 * MIB);
    expect(h.supervisor.reservedBytes()).toBe(34 * MIB);
    admission.reservation.release();
    admission.reservation.release();
    expect(h.supervisor.reservedBytes()).toBe(0);
    expect(watch.snapshot().reservedBytes).toBe(0);
  });

  it("refuses once the sample is older than 500 ms and never bypasses", () => {
    const h = harness();
    const { watch } = h.spawn("a", 10 * MIB);
    h.supervisor.sampleNow();
    h.advance(500);
    expect(watch.provider.sample()).not.toBeNull();
    const atLimit = admitMemory(watch.provider, SUPERVISED_MEMORY_POLICY, 0);
    expect(atLimit.ok).toBe(true);
    if (atLimit.ok) atLimit.reservation.release();
    h.advance(1);
    expect(watch.provider.sample()).toBeNull();
    const lax = { ...SUPERVISED_MEMORY_POLICY, maxSampleAgeMs: 60_000 };
    expect(admitMemory(watch.provider, lax, 0).ok).toBe(false);
    expect(watch.provider.acquire(MIB)).toBeNull();
    expect(h.supervisor.reservedBytes()).toBe(0);
  });

  it("treats a failing read as absent and lets the sample age out", () => {
    const h = harness();
    const { child, watch } = h.spawn("a", 10 * MIB);
    h.supervisor.sampleNow();
    h.rss.delete(child.pid);
    h.advance(100);
    h.supervisor.sampleNow();
    expect(watch.provider.sample()).not.toBeNull();
    expect(watch.snapshot().readFailures).toBe(1);
    h.advance(450);
    h.supervisor.sampleNow();
    expect(watch.provider.sample()).toBeNull();
    expect(watch.snapshot().unreadable).toBe(true);
    expect(h.supervisor.snapshot().unsupported).toBe(true);
    expect(watch.provider.acquire(MIB)).toBeNull();
  });

  it("reports a child that was never readable as unsupported", () => {
    const h = harness();
    const { watch } = h.spawn("a", null);
    h.supervisor.sampleNow();
    expect(h.supervisor.snapshot().unsupported).toBe(false);
    h.advance(501);
    h.supervisor.sampleNow();
    expect(watch.snapshot().unreadable).toBe(true);
    expect(h.supervisor.snapshot().unsupported).toBe(true);
  });

  it("suspends a child at 192 MiB and resumes only on a fresh lower sample", () => {
    const h = harness();
    const { child, watch } = h.spawn("a", 192 * MIB - 1);
    h.supervisor.sampleNow();
    expect(watch.snapshot().suspended).toBe(false);
    const ok = watch.provider.acquire(1);
    expect(ok).not.toBeNull();
    ok?.release();
    h.rss.set(child.pid, 192 * MIB);
    h.advance(100);
    h.supervisor.sampleNow();
    expect(watch.snapshot().suspended).toBe(true);
    expect(watch.provider.acquire(1)).toBeNull();
    expect(child.killCalls).toBe(0);
    h.rss.set(child.pid, 100 * MIB);
    h.advance(100);
    h.supervisor.sampleNow();
    expect(watch.snapshot().suspended).toBe(false);
    expect(watch.provider.acquire(1)).not.toBeNull();
  });

  it("applies the headroom rule at the 192 MiB ceiling", () => {
    const h = harness();
    const { child, watch } = h.spawn("a", 160 * MIB - 1);
    h.supervisor.sampleNow();
    expect(admitMemory(watch.provider, SUPERVISED_MEMORY_POLICY, 0).ok).toBe(
      true,
    );
    h.rss.set(child.pid, 160 * MIB);
    h.advance(100);
    h.supervisor.sampleNow();
    expect(admitMemory(watch.provider, SUPERVISED_MEMORY_POLICY, 0).ok).toBe(
      false,
    );
    h.rss.set(child.pid, 100 * MIB);
    h.advance(100);
    h.supervisor.sampleNow();
    const batch = 30 * MIB;
    expect(
      admitMemory(watch.provider, SUPERVISED_MEMORY_POLICY, batch).ok,
    ).toBe(false);
    expect(
      admitMemory(watch.provider, SUPERVISED_MEMORY_POLICY, batch - 3 * MIB).ok,
    ).toBe(true);
  });

  it("kills a child at exactly 256 MiB and not below", async () => {
    const h = harness();
    const { child, watch } = h.spawn("a", 256 * MIB - 1);
    h.supervisor.sampleNow();
    await flush();
    expect(child.killCalls).toBe(0);
    h.rss.set(child.pid, 256 * MIB);
    h.advance(100);
    h.supervisor.sampleNow();
    await flush();
    expect(child.killCalls).toBe(1);
    const [record] = h.supervisor.kills();
    expect(record?.reason).toBe("child_rss");
    expect(record?.rssBytes).toBe(256 * MIB);
    expect(record?.thresholdBytes).toBe(256 * MIB);
    expect(record?.reapLatencyMs).toBe(3);
    expect(watch.provider.acquire(1)).toBeNull();
    h.supervisor.sampleNow();
    await flush();
    expect(child.killCalls).toBe(1);
  });

  it("releases reservations when the child exits", async () => {
    const h = harness();
    const { child, watch } = h.spawn("a", 10 * MIB);
    h.supervisor.sampleNow();
    const first = watch.provider.acquire(100 * MIB);
    const second = watch.provider.acquire(50 * MIB);
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(h.supervisor.reservedBytes()).toBe(150 * MIB);
    child.exit();
    await flush();
    expect(h.supervisor.reservedBytes()).toBe(0);
    first?.release();
    second?.release();
    expect(h.supervisor.reservedBytes()).toBe(0);
    expect(h.supervisor.snapshot().children).toHaveLength(0);
    expect(h.supervisor.retiredChildren()).toHaveLength(1);
  });

  it("releases reservations when the child is killed", async () => {
    const h = harness();
    const { child, watch } = h.spawn("a", 10 * MIB);
    h.supervisor.sampleNow();
    expect(watch.provider.acquire(64 * MIB)).not.toBeNull();
    h.rss.set(child.pid, 300 * MIB);
    h.advance(100);
    h.supervisor.sampleNow();
    await flush();
    expect(h.supervisor.reservedBytes()).toBe(0);
  });

  it("caps aggregate reservations at 768 MiB", () => {
    const h = harness();
    const a = h.spawn("a", MIB);
    const b = h.spawn("b", MIB);
    const c = h.spawn("c", MIB);
    h.supervisor.sampleNow();
    const held = [
      a.watch.provider.acquire(256 * MIB),
      b.watch.provider.acquire(256 * MIB),
      c.watch.provider.acquire(256 * MIB - 1),
    ];
    expect(held.every((entry) => entry !== null)).toBe(true);
    expect(c.watch.provider.acquire(2)).toBeNull();
    const last = c.watch.provider.acquire(1);
    expect(last).not.toBeNull();
    expect(h.supervisor.reservedBytes()).toBe(768 * MIB);
    expect(a.watch.provider.acquire(1)).toBeNull();
    held[0]?.release();
    expect(a.watch.provider.acquire(256 * MIB)).not.toBeNull();
  });

  it("suspends admission when summed RSS reaches 640 MiB", () => {
    const h = harness();
    const children = [0, 1, 2, 3].map((index) =>
      h.spawn(`c${index}`, 160 * MIB - 1),
    );
    h.supervisor.sampleNow();
    expect(h.supervisor.snapshot().aggregateSuspended).toBe(false);
    expect(children[0]?.watch.provider.acquire(MIB)).not.toBeNull();
    const first = children[0];
    if (first === undefined) return;
    h.rss.set(first.child.pid, 160 * MIB + 3);
    h.advance(100);
    h.supervisor.sampleNow();
    const snapshot = h.supervisor.snapshot();
    expect(snapshot.aggregateRssBytes).toBe(640 * MIB);
    expect(snapshot.aggregateSuspended).toBe(true);
    for (const entry of children) {
      expect(entry.watch.provider.acquire(1)).toBeNull();
    }
    h.rss.set(first.child.pid, 100 * MIB);
    h.advance(100);
    h.supervisor.sampleNow();
    expect(h.supervisor.snapshot().aggregateSuspended).toBe(false);
    expect(first.watch.provider.acquire(1)).not.toBeNull();
  });

  it("terminates the largest child when summed RSS reaches 768 MiB", async () => {
    const h = harness();
    const sizes = [200 * MIB, 190 * MIB, 190 * MIB, 188 * MIB - 1];
    const children = sizes.map((size, index) => h.spawn(`c${index}`, size));
    h.supervisor.sampleNow();
    await flush();
    expect(h.supervisor.kills()).toHaveLength(0);
    expect(children.every((entry) => entry.child.killCalls === 0)).toBe(true);
    const target = children[3];
    if (target === undefined) return;
    h.rss.set(target.child.pid, 188 * MIB);
    h.advance(100);
    h.supervisor.sampleNow();
    await flush();
    const [record] = h.supervisor.kills();
    expect(record?.reason).toBe("aggregate_rss");
    expect(record?.label).toBe("c0");
    expect(record?.thresholdBytes).toBe(768 * MIB);
    expect(children[0]?.child.killCalls).toBe(1);
    expect(
      children.slice(1).every((entry) => entry.child.killCalls === 0),
    ).toBe(true);
    expect(h.supervisor.snapshot().aggregateRssBytes).toBe(568 * MIB);
  });

  it("records sampling gaps and the peak sampled RSS", () => {
    const h = harness();
    const { child, watch } = h.spawn("a", 10 * MIB);
    h.supervisor.sampleNow();
    h.advance(100);
    h.rss.set(child.pid, 30 * MIB);
    h.supervisor.sampleNow();
    h.advance(340);
    h.rss.set(child.pid, 20 * MIB);
    h.supervisor.sampleNow();
    h.advance(120);
    h.supervisor.sampleNow();
    const snapshot = watch.snapshot();
    expect(snapshot.samples).toBe(4);
    expect(snapshot.maxSampleGapMs).toBe(340);
    expect(snapshot.peakRssBytes).toBe(30 * MIB);
    expect(snapshot.osPeakRssBytes).toBe(30 * MIB);
  });

  it("rejects invalid reservation sizes", () => {
    const h = harness();
    const { watch } = h.spawn("a", MIB);
    h.supervisor.sampleNow();
    expect(watch.provider.acquire(-1)).toBeNull();
    expect(watch.provider.acquire(Number.NaN)).toBeNull();
    expect(watch.provider.acquire(Number.POSITIVE_INFINITY)).toBeNull();
    expect(h.supervisor.reservedBytes()).toBe(0);
  });
});

describe("proc status parsing", () => {
  it("reads resident and peak kilobytes", () => {
    const text =
      "Name:\tnode\nVmHWM:\t  2048 kB\nVmRSS:\t  1024 kB\nThreads:\t4\n";
    expect(parseProcStatus(text)).toEqual({
      rssBytes: 1024 * 1024,
      peakRssBytes: 2048 * 1024,
    });
  });

  it("returns null without a resident line", () => {
    expect(parseProcStatus("Name:\tzombie\nState:\tZ\n")).toBeNull();
  });
});
