import { describe, expect, it } from "vitest";

import {
  DEFAULT_QUANTUM_MS,
  ParserScheduler,
  type CommitSink,
  type ParserHandle,
  type ParserOutcome,
  type ParserReadInput,
  type ParserSourceSpec,
  type RefusalCode,
  type SchedulerEvent,
} from "../src/index.js";
import type { CommitResult } from "../src/storage.js";

interface Step {
  cost: number;
  outcome: ParserOutcome | (() => ParserOutcome | Promise<ParserOutcome>);
}

class Clock {
  now = 0;
  read = (): number => this.now;
}

function spec(key: string, generation = 1): ParserSourceSpec {
  return {
    ref: { key, generation, discoveredAtMs: 1 },
    provider: "claude",
    path: `/fixture/${key}.jsonl`,
  };
}

function pageOutcome(
  next: string,
  endOfFile = false,
  expected: string | null = null,
): ParserOutcome {
  return {
    kind: "page",
    page: {
      status: "page",
      batch: {
        source: { key: "x", generation: 1, discoveredAtMs: 1 },
        records: [],
      },
      cursor: { expected, next },
      skipped: {},
      progress: { endOfFile },
    },
  } as unknown as ParserOutcome;
}

function idleOutcome(): ParserOutcome {
  return {
    kind: "page",
    page: { status: "idle", batch: null, cursor: null },
  } as unknown as ParserOutcome;
}

function invalidatedOutcome(): ParserOutcome {
  return {
    kind: "page",
    page: { status: "invalidated", reason: "truncated" },
  } as unknown as ParserOutcome;
}

class ScriptedParser implements ParserHandle {
  readonly reads: ParserReadInput[] = [];
  readonly scripts = new Map<string, Step[]>();

  constructor(
    readonly label: string,
    private readonly clock: Clock,
  ) {}

  script(key: string, steps: Step[]): void {
    this.scripts.set(key, steps);
  }

  async read(input: ParserReadInput): Promise<ParserOutcome> {
    this.reads.push(input);
    const steps = this.scripts.get(input.source.ref.key);
    const step = steps?.shift();
    if (step === undefined) return idleOutcome();
    await Promise.resolve();
    this.clock.now += step.cost;
    const outcome =
      typeof step.outcome === "function" ? await step.outcome() : step.outcome;
    if (outcome.kind === "page" && outcome.page.status === "page") {
      outcome.page.batch = { ...outcome.page.batch, source: input.source.ref };
    }
    return outcome;
  }

  async close(): Promise<void> {}
}

class FakeSink implements CommitSink {
  readonly cursors = new Map<string, string>();
  readonly commits: string[] = [];
  readonly refusals = new Map<string, Array<RefusalCode | "throw">>();

  cursor(ref: { key: string }): string | null {
    return this.cursors.get(ref.key) ?? null;
  }

  commit(
    batch: { source: { key: string } },
    update: { expected: string | null; next: string },
  ): CommitResult {
    const key = batch.source.key;
    const queue = this.refusals.get(key);
    const refusal = queue?.shift();
    if (refusal === "throw") throw new Error("sink exploded");
    if (refusal !== undefined) {
      return {
        committed: false,
        refusal: { code: refusal, message: `refused ${refusal}` },
        cursor: this.cursors.get(key) ?? null,
      } as unknown as CommitResult;
    }
    this.cursors.set(key, update.next);
    this.commits.push(key);
    return {
      committed: true,
      refusal: null,
      cursor: update.next,
    } as unknown as CommitResult;
  }
}

function harness(options: {
  parsers?: number;
  quantumMs?: number;
  stallMs?: number;
  maxTerminations?: number;
}) {
  const clock = new Clock();
  const parsers = Array.from(
    { length: options.parsers ?? 1 },
    (_, index) => new ScriptedParser(`p${index}`, clock),
  );
  const sink = new FakeSink();
  const events: SchedulerEvent[] = [];
  const scheduler = new ParserScheduler({
    parsers,
    sink,
    clock: clock.read,
    quantumMs: options.quantumMs,
    stallMs: options.stallMs,
    maxTerminations: options.maxTerminations,
    onEvent: (event) => events.push(event),
  });
  return { clock, parsers, sink, events, scheduler };
}

function chain(count: number, cost: number, finalEof = true): Step[] {
  return Array.from({ length: count }, (_, index) => ({
    cost,
    outcome: pageOutcome(
      `c${index + 1}`,
      finalEof && index === count - 1,
      index === 0 ? null : `c${index}`,
    ),
  }));
}

describe("ParserScheduler quantum", () => {
  it("uses a 2 s quantum by default", () => {
    expect(DEFAULT_QUANTUM_MS).toBe(2_000);
  });

  it("yields a long source after its quantum so a small source runs before the long source finishes", async () => {
    const { parsers, sink, scheduler, events } = harness({ quantumMs: 2_000 });
    parsers[0]!.script("big", chain(10, 700));
    parsers[0]!.script("small", chain(1, 100));
    scheduler.upsert(spec("big"));
    scheduler.upsert(spec("small"));
    await scheduler.drain();
    expect(sink.commits.slice(0, 4)).toEqual(["big", "big", "big", "small"]);
    expect(sink.commits.filter((key) => key === "big")).toHaveLength(10);
    expect(
      events.filter((event) => event.type === "yield").length,
    ).toBeGreaterThanOrEqual(3);
    expect(scheduler.state("small")?.status).toBe("idle");
    expect(scheduler.state("big")?.status).toBe("idle");
  });

  it("rotates across many sources in turn order", async () => {
    const { parsers, sink, scheduler } = harness({ quantumMs: 1_000 });
    for (const key of ["a", "b", "c"]) {
      parsers[0]!.script(key, chain(4, 500));
      scheduler.upsert(spec(key));
    }
    await scheduler.drain();
    expect(sink.commits).toEqual([
      "a",
      "a",
      "b",
      "b",
      "c",
      "c",
      "a",
      "a",
      "b",
      "b",
      "c",
      "c",
    ]);
  });

  it("lets two parsers work different sources at the same time", async () => {
    const { parsers, sink, scheduler } = harness({
      parsers: 2,
      quantumMs: 1_000,
    });
    parsers[0]!.script("a", chain(2, 100));
    parsers[1]!.script("b", chain(2, 100));
    scheduler.upsert(spec("a"));
    scheduler.upsert(spec("b"));
    await scheduler.drain();
    expect(sink.commits.sort()).toEqual(["a", "a", "b", "b"]);
    expect(parsers[0]!.reads.length).toBeGreaterThan(0);
    expect(parsers[1]!.reads.length).toBeGreaterThan(0);
  });

  it("resumes from the stored cursor", async () => {
    const { parsers, sink, scheduler } = harness({});
    sink.cursors.set("a", "stored");
    parsers[0]!.script("a", chain(1, 10));
    scheduler.upsert(spec("a"));
    await scheduler.drain();
    expect(parsers[0]!.reads[0]!.cursor).toBe("stored");
  });

  it("passes the stall deadline to the parser", async () => {
    const { parsers, scheduler } = harness({ stallMs: 777 });
    parsers[0]!.script("a", chain(1, 10));
    scheduler.upsert(spec("a"));
    await scheduler.drain();
    expect(parsers[0]!.reads[0]!.stallMs).toBe(777);
  });
});

describe("ParserScheduler containment", () => {
  it("quarantines a stalled generation and keeps indexing the next source", async () => {
    const { parsers, sink, scheduler, events } = harness({});
    parsers[0]!.script("bad", [
      { cost: 5_000, outcome: { kind: "stalled", message: "no response" } },
    ]);
    parsers[0]!.script("good", chain(2, 10));
    scheduler.upsert(spec("bad"));
    scheduler.upsert(spec("good"));
    await scheduler.drain();
    expect(scheduler.state("bad")?.status).toBe("quarantined");
    expect(scheduler.state("bad")?.reason).toContain("stalled");
    expect(
      parsers[0]!.reads.filter((r) => r.source.ref.key === "bad"),
    ).toHaveLength(1);
    expect(sink.commits).toEqual(["good", "good"]);
    expect(
      events.some((e) => e.type === "quarantined" && e.key === "bad"),
    ).toBe(true);
  });

  it("does not retry a quarantined generation but retries a changed generation", async () => {
    const { parsers, sink, scheduler } = harness({});
    parsers[0]!.script("bad", [
      { cost: 1, outcome: { kind: "stalled", message: "no response" } },
    ]);
    scheduler.upsert(spec("bad", 1));
    await scheduler.drain();
    scheduler.upsert(spec("bad", 1));
    await scheduler.drain();
    expect(scheduler.state("bad")?.status).toBe("quarantined");
    expect(parsers[0]!.reads).toHaveLength(1);
    parsers[0]!.script("bad", chain(1, 1));
    scheduler.upsert(spec("bad", 2));
    await scheduler.drain();
    expect(scheduler.state("bad")?.status).toBe("idle");
    expect(sink.commits).toEqual(["bad"]);
  });

  it("quarantines a protocol violation and a failed or oversized page", async () => {
    const { parsers, sink, scheduler } = harness({});
    parsers[0]!.script("violate", [
      {
        cost: 1,
        outcome: {
          kind: "terminated",
          cause: "protocol_violation",
          message: "bad frame",
        },
      },
    ]);
    parsers[0]!.script("failed", [
      { cost: 1, outcome: { kind: "error", code: "failed", message: "boom" } },
    ]);
    parsers[0]!.script("large", [
      {
        cost: 1,
        outcome: { kind: "error", code: "page_too_large", message: "too big" },
      },
    ]);
    parsers[0]!.script("good", chain(1, 1));
    for (const key of ["violate", "failed", "large", "good"]) {
      scheduler.upsert(spec(key));
    }
    await scheduler.drain();
    expect(scheduler.state("violate")?.status).toBe("quarantined");
    expect(scheduler.state("failed")?.status).toBe("quarantined");
    expect(scheduler.state("large")?.status).toBe("quarantined");
    expect(sink.commits).toEqual(["good"]);
  });

  it("quarantines a batch the store calls invalid and continues", async () => {
    const { parsers, sink, scheduler } = harness({});
    parsers[0]!.script("bad", chain(2, 1));
    parsers[0]!.script("good", chain(1, 1));
    sink.refusals.set("bad", ["invalid_batch"]);
    scheduler.upsert(spec("bad"));
    scheduler.upsert(spec("good"));
    await scheduler.drain();
    expect(scheduler.state("bad")?.status).toBe("quarantined");
    expect(sink.commits).toEqual(["good"]);
  });

  it("retries once after a crash and suspends at the second consecutive crash of one generation", async () => {
    const { parsers, scheduler, events } = harness({});
    const crash: Step = {
      cost: 1,
      outcome: { kind: "terminated", cause: "crash", message: "exit 70" },
    };
    parsers[0]!.script("flaky", [crash, { ...crash }, ...chain(1, 1)]);
    scheduler.upsert(spec("flaky"));
    await scheduler.drain();
    expect(scheduler.state("flaky")?.status).toBe("suspended");
    expect(parsers[0]!.reads).toHaveLength(2);
    expect(events.map((e) => e.type)).toEqual(["retry", "suspended"]);
  });

  it("resets the termination count after a good page", async () => {
    const { parsers, scheduler } = harness({});
    const crash: Step = {
      cost: 1,
      outcome: { kind: "terminated", cause: "crash", message: "exit 70" },
    };
    parsers[0]!.script("flaky", [
      crash,
      ...chain(2, 1, false),
      { ...crash },
      ...chain(1, 1),
    ]);
    scheduler.upsert(spec("flaky"));
    await scheduler.drain();
    expect(scheduler.state("flaky")?.status).toBe("idle");
    expect(scheduler.state("flaky")?.consecutiveTerminations).toBe(0);
  });

  it("retries a suspended source when the generation changes", async () => {
    const { parsers, sink, scheduler } = harness({});
    const crash: Step = {
      cost: 1,
      outcome: { kind: "terminated", cause: "memory_kill", message: "killed" },
    };
    parsers[0]!.script("flaky", [crash, { ...crash }]);
    scheduler.upsert(spec("flaky", 1));
    await scheduler.drain();
    expect(scheduler.state("flaky")?.status).toBe("suspended");
    scheduler.upsert(spec("flaky", 1));
    await scheduler.drain();
    expect(scheduler.state("flaky")?.status).toBe("suspended");
    parsers[0]!.script("flaky", chain(1, 1));
    scheduler.upsert(spec("flaky", 2));
    await scheduler.drain();
    expect(scheduler.state("flaky")?.status).toBe("idle");
    expect(sink.commits).toEqual(["flaky"]);
  });

  it("skips an unreadable source, indexes the others and retries it after a backoff", async () => {
    const { parsers, sink, clock, scheduler } = harness({});
    parsers[0]!.script("locked", [
      {
        cost: 1,
        outcome: { kind: "error", code: "unreadable", message: "EACCES" },
      },
    ]);
    parsers[0]!.script("a", chain(2, 1));
    parsers[0]!.script("b", chain(2, 1));
    scheduler.upsert(spec("locked"));
    scheduler.upsert(spec("a"));
    scheduler.upsert(spec("b"));
    await scheduler.drain();
    expect(sink.commits.sort()).toEqual(["a", "a", "b", "b"]);
    expect(scheduler.state("locked")?.status).toBe("unreadable");
    expect(scheduler.state("locked")?.reason).toBe("EACCES");
    const wake = scheduler.nextWakeAtMs();
    expect(wake).not.toBeNull();
    parsers[0]!.script("locked", chain(1, 1));
    clock.now = wake!;
    await scheduler.drain();
    expect(scheduler.state("locked")?.status).toBe("idle");
    expect(sink.commits).toContain("locked");
  });

  it("backs off an unreadable source exponentially up to a cap", async () => {
    const clock = new Clock();
    const parser = new ScriptedParser("p0", clock);
    const sink = new FakeSink();
    const scheduler = new ParserScheduler({
      parsers: [parser],
      sink,
      clock: clock.read,
      unreadableBackoffMs: 100,
      unreadableBackoffMaxMs: 350,
    });
    const unreadable: Step = {
      cost: 0,
      outcome: { kind: "error", code: "unreadable", message: "EACCES" },
    };
    parser.script("locked", [
      unreadable,
      { ...unreadable },
      { ...unreadable },
      { ...unreadable },
    ]);
    scheduler.upsert(spec("locked"));
    const waits: number[] = [];
    for (let round = 0; round < 4; round += 1) {
      await scheduler.drain();
      waits.push(scheduler.state("locked")!.notBeforeMs - clock.now);
      clock.now = scheduler.nextWakeAtMs()!;
    }
    expect(waits).toEqual([100, 200, 350, 350]);
  });

  it("defers a source the store refuses and retries it after the backoff", async () => {
    const { parsers, sink, clock, scheduler } = harness({});
    parsers[0]!.script("a", chain(1, 1));
    sink.refusals.set("a", ["memory_pressure"]);
    scheduler.upsert(spec("a"));
    await scheduler.drain();
    expect(scheduler.state("a")?.status).toBe("deferred");
    expect(scheduler.state("a")?.reason).toContain("memory_pressure");
    parsers[0]!.script("a", chain(1, 1));
    clock.now = scheduler.nextWakeAtMs()!;
    await scheduler.drain();
    expect(scheduler.state("a")?.status).toBe("idle");
    expect(sink.commits).toEqual(["a"]);
  });

  it("defers a source whose parser was refused memory admission", async () => {
    const { parsers, clock, scheduler } = harness({});
    parsers[0]!.script("a", [
      { cost: 1, outcome: { kind: "refused", message: "stale sample" } },
      ...chain(1, 1),
    ]);
    scheduler.upsert(spec("a"));
    await scheduler.drain();
    expect(scheduler.state("a")?.status).toBe("deferred");
    clock.now = scheduler.nextWakeAtMs()!;
    await scheduler.drain();
    expect(scheduler.state("a")?.status).toBe("idle");
  });

  it("defers when the sink throws", async () => {
    const { parsers, sink, scheduler } = harness({});
    parsers[0]!.script("a", chain(1, 1));
    sink.refusals.set("a", ["throw"]);
    scheduler.upsert(spec("a"));
    await scheduler.drain();
    expect(scheduler.state("a")?.status).toBe("deferred");
    expect(scheduler.state("a")?.reason).toBe("sink exploded");
  });

  it("rereads the cursor after a conflict and defers after repeated conflicts", async () => {
    const { parsers, sink, scheduler } = harness({});
    parsers[0]!.script("a", chain(3, 1));
    sink.refusals.set("a", ["cursor_conflict"]);
    scheduler.upsert(spec("a"));
    await scheduler.drain();
    expect(scheduler.state("a")?.status).toBe("idle");

    const second = harness({});
    second.parsers[0]!.script("b", chain(5, 1));
    second.sink.refusals.set("b", [
      "cursor_conflict",
      "cursor_conflict",
      "cursor_conflict",
    ]);
    second.scheduler.upsert(spec("b"));
    await second.scheduler.drain();
    expect(second.scheduler.state("b")?.status).toBe("deferred");
  });

  it("parks an invalidated source and reports it", async () => {
    const { parsers, scheduler, events } = harness({});
    parsers[0]!.script("a", [{ cost: 1, outcome: invalidatedOutcome() }]);
    scheduler.upsert(spec("a"));
    await scheduler.drain();
    expect(scheduler.state("a")?.status).toBe("invalidated");
    expect(events.find((e) => e.type === "invalidated")?.detail).toBe(
      "truncated",
    );
  });

  it("returns an idle source to the queue on notify", async () => {
    const { parsers, sink, scheduler } = harness({});
    parsers[0]!.script("a", chain(1, 1));
    scheduler.upsert(spec("a"));
    await scheduler.drain();
    expect(scheduler.state("a")?.status).toBe("idle");
    parsers[0]!.script("a", chain(1, 1));
    scheduler.notify("a");
    await scheduler.drain();
    expect(sink.commits).toEqual(["a", "a"]);
  });

  it("ignores an outcome that arrives after the source was replaced", async () => {
    const { parsers, sink, scheduler } = harness({});
    parsers[0]!.script("a", [
      {
        cost: 1,
        outcome: () => {
          scheduler.upsert(spec("a", 2));
          return { kind: "stalled", message: "late" };
        },
      },
    ]);
    scheduler.upsert(spec("a", 1));
    await scheduler.drain();
    expect(scheduler.state("a")?.spec.ref.generation).toBe(2);
    expect(scheduler.state("a")?.status).not.toBe("quarantined");
    expect(sink.commits).toEqual([]);
  });

  it("drops a removed source", async () => {
    const { parsers, scheduler } = harness({});
    parsers[0]!.script("a", chain(1, 1));
    scheduler.upsert(spec("a"));
    scheduler.remove("a");
    await scheduler.drain();
    expect(scheduler.state("a")).toBeNull();
    expect(parsers[0]!.reads).toHaveLength(0);
  });

  it("treats a thrown parser error as a crash", async () => {
    const { parsers, scheduler, events } = harness({});
    parsers[0]!.script("a", [
      {
        cost: 1,
        outcome: () => {
          throw new Error("handle failed");
        },
      },
    ]);
    scheduler.upsert(spec("a"));
    await scheduler.drain();
    expect(events.map((event) => event.type)).toContain("retry");
    expect(events.find((event) => event.type === "retry")?.detail).toBe(
      "handle failed",
    );
  });
});
