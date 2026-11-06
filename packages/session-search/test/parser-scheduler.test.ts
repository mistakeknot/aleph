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
import { DEFAULT_PARSER_READERS } from "../src/parser/child.js";
import {
  pageBindingViolation,
  parseParserResponse,
  validNormalizedRecord,
  validateSourcePage,
} from "../src/parser/protocol.js";
import type { CommitResult } from "../src/storage.js";
import { fixturePath } from "./helpers.js";

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
      outcome.page.cursor = { ...outcome.page.cursor, expected: input.cursor };
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
    fence: () => boolean = () => true,
  ): CommitResult {
    const key = batch.source.key;
    if (!fence()) {
      return {
        committed: false,
        refusal: {
          code: "stale_generation",
          message: "source generation is no longer current",
        },
        cursor: this.cursors.get(key) ?? null,
      } as unknown as CommitResult;
    }
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
  maxSinkFailures?: number;
  deferBackoffMs?: number;
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
    maxSinkFailures: options.maxSinkFailures,
    deferBackoffMs: options.deferBackoffMs,
    onEvent: (event) => events.push(event),
  });
  return { clock, parsers, sink, events, scheduler };
}

async function settle(
  scheduler: ParserScheduler,
  clock: Clock,
  rounds = 20,
): Promise<void> {
  for (let round = 0; round < rounds; round += 1) {
    await scheduler.drain();
    const wake = scheduler.nextWakeAtMs();
    if (wake === null) return;
    clock.now = Math.max(clock.now, wake);
  }
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
    const { parsers, scheduler, events, clock } = harness({});
    const crash: Step = {
      cost: 1,
      outcome: { kind: "terminated", cause: "crash", message: "exit 70" },
    };
    parsers[0]!.script("flaky", [crash, { ...crash }, ...chain(1, 1)]);
    scheduler.upsert(spec("flaky"));
    await settle(scheduler, clock);
    expect(scheduler.state("flaky")?.status).toBe("suspended");
    expect(parsers[0]!.reads).toHaveLength(2);
    expect(events.map((e) => e.type)).toEqual(["retry", "suspended"]);
  });

  it("resets the termination count after a good page", async () => {
    const { parsers, scheduler, clock } = harness({});
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
    await settle(scheduler, clock);
    expect(scheduler.state("flaky")?.status).toBe("idle");
    expect(scheduler.state("flaky")?.consecutiveTerminations).toBe(0);
  });

  it("retries a suspended source when the generation changes", async () => {
    const { parsers, sink, scheduler, clock } = harness({});
    const crash: Step = {
      cost: 1,
      outcome: { kind: "terminated", cause: "memory_kill", message: "killed" },
    };
    parsers[0]!.script("flaky", [crash, { ...crash }]);
    scheduler.upsert(spec("flaky", 1));
    await settle(scheduler, clock);
    expect(scheduler.state("flaky")?.status).toBe("suspended");
    scheduler.upsert(spec("flaky", 1));
    await settle(scheduler, clock);
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

function fullPage(): Record<string, unknown> {
  return {
    status: "page",
    batch: {
      source: { key: "a", generation: 1, discoveredAtMs: 1 },
      records: [],
    },
    cursor: { expected: null, next: "c1" },
    skipped: {
      blank: 0,
      invalidUtf8: 0,
      invalidJson: 0,
      ignored: 0,
      samples: [],
    },
    progress: {
      startOffset: 0,
      nextOffset: 10,
      bytesConsumed: 10,
      lines: 1,
      recordCount: 0,
      placeholderCount: 0,
      waitingPartialBytes: 0,
      endOfFile: true,
    },
  };
}

function framed(page: unknown): Buffer {
  return Buffer.from(JSON.stringify({ t: "page", id: 1, page }));
}

describe("page validation", () => {
  it("accepts a complete page, idle page and invalidated page", () => {
    expect(validateSourcePage(fullPage())).not.toBeNull();
    expect(
      validateSourcePage({
        ...fullPage(),
        status: "idle",
        batch: null,
        cursor: null,
      }),
    ).not.toBeNull();
    expect(
      validateSourcePage({ status: "invalidated", reason: "truncated" }),
    ).not.toBeNull();
    expect(parseParserResponse(framed(fullPage()))?.t).toBe("page");
  });

  it.each([
    [
      "a page without progress",
      (page: Record<string, unknown>) => delete page.progress,
    ],
    [
      "a page without skipped",
      (page: Record<string, unknown>) => delete page.skipped,
    ],
    [
      "a page without a cursor",
      (page: Record<string, unknown>) => delete page.cursor,
    ],
    [
      "a page with an empty next cursor",
      (page: Record<string, unknown>) => {
        page.cursor = { expected: null, next: "" };
      },
    ],
    [
      "a page with a numeric expected cursor",
      (page: Record<string, unknown>) => {
        page.cursor = { expected: 4, next: "c1" };
      },
    ],
    [
      "a page with a negative counter",
      (page: Record<string, unknown>) => {
        page.progress = { ...(page.progress as object), lines: -1 };
      },
    ],
    [
      "a page with a fractional counter",
      (page: Record<string, unknown>) => {
        page.progress = { ...(page.progress as object), nextOffset: 1.5 };
      },
    ],
    [
      "a page whose end of file is not a boolean",
      (page: Record<string, unknown>) => {
        page.progress = { ...(page.progress as object), endOfFile: "yes" };
      },
    ],
    [
      "a page without a batch",
      (page: Record<string, unknown>) => {
        page.batch = null;
      },
    ],
    [
      "a page whose records are not an array",
      (page: Record<string, unknown>) => {
        page.batch = { ...(page.batch as object), records: {} };
      },
    ],
    [
      "a page whose source has no key",
      (page: Record<string, unknown>) => {
        page.batch = {
          ...(page.batch as object),
          source: { generation: 1, discoveredAtMs: 1 },
        };
      },
    ],
    [
      "a page with skipped samples that are not objects",
      (page: Record<string, unknown>) => {
        page.skipped = { ...(page.skipped as object), samples: [1] };
      },
    ],
    [
      "an idle page that carries a batch",
      (page: Record<string, unknown>) => {
        page.status = "idle";
        page.cursor = null;
      },
    ],
    [
      "a page with an unknown status",
      (page: Record<string, unknown>) => {
        page.status = "done";
      },
    ],
  ])("rejects %s", (_name, mutate) => {
    const page = fullPage();
    mutate(page);
    expect(validateSourcePage(page)).toBeNull();
    expect(parseParserResponse(framed(page))).toBeNull();
  });

  it("rejects an invalidated page with an unknown reason and a non-object page", () => {
    expect(
      validateSourcePage({ status: "invalidated", reason: "because" }),
    ).toBeNull();
    expect(validateSourcePage({ status: "invalidated" })).toBeNull();
    expect(validateSourcePage(null)).toBeNull();
    expect(validateSourcePage([])).toBeNull();
    expect(parseParserResponse(framed("page"))).toBeNull();
  });
});

const BASE_RECORD = {
  provider: "claude",
  sessionId: "s1",
  agentId: null,
  parentCallId: null,
  cwd: "/work",
  sidechain: false,
  eventTimeMs: 5,
  dedupeKey: "k1",
};

const USAGE_RECORD = {
  ...BASE_RECORD,
  kind: "usage",
  basis: "delta",
  origin: "claude-message",
  scopeKey: "scope",
  model: null,
  inputIncludesCache: null,
  costUsd: null,
  inputTokens: 1,
  outputTokens: 2,
  cacheReadTokens: null,
  cacheWriteTokens: null,
  reasoningTokens: null,
  totalTokens: 3,
};

const RECORDS: Record<string, Record<string, unknown>> = {
  message: { ...BASE_RECORD, kind: "message", role: "user", text: "hello" },
  tool_call: {
    ...BASE_RECORD,
    kind: "tool_call",
    callId: "c1",
    name: "Read",
    argumentsText: "{}",
    delegation: false,
    touches: [{ path: "/a", access: "read", confidence: "structured" }],
  },
  tool_result: {
    ...BASE_RECORD,
    kind: "tool_result",
    callId: "c1",
    text: "ok",
  },
  session: { ...BASE_RECORD, kind: "session", model: "m" },
  usage: USAGE_RECORD,
};

function pageWith(
  records: unknown[],
  placeholders?: unknown[],
): Record<string, unknown> {
  const page = fullPage();
  const batch = page.batch as Record<string, unknown>;
  page.batch =
    placeholders === undefined
      ? { ...batch, records }
      : { ...batch, records, placeholders };
  return page;
}

describe("record validation", () => {
  it.each(Object.keys(RECORDS))("accepts a valid %s record", (kind) => {
    expect(validNormalizedRecord(RECORDS[kind])).toBe(true);
    expect(validateSourcePage(pageWith([RECORDS[kind]]))).not.toBeNull();
    expect(parseParserResponse(framed(pageWith([RECORDS[kind]])))?.t).toBe(
      "page",
    );
  });

  it.each([
    ["an empty object", {}],
    ["a null", null],
    ["an array", []],
    ["a string", "record"],
    ["an unknown kind", { ...BASE_RECORD, kind: "mystery" }],
    ["a record without a kind", { ...BASE_RECORD }],
  ])("rejects %s as a record", (_name, value) => {
    expect(validNormalizedRecord(value)).toBe(false);
    expect(validateSourcePage(pageWith([value]))).toBeNull();
    expect(parseParserResponse(framed(pageWith([value])))).toBeNull();
  });

  const required: Array<[string, string]> = [];
  for (const [kind, record] of Object.entries(RECORDS)) {
    for (const field of Object.keys(record)) {
      required.push([kind, field]);
    }
  }

  it.each(required)("rejects a %s record missing %s", (kind, field) => {
    const record = { ...RECORDS[kind]! };
    delete record[field];
    expect(validNormalizedRecord(record)).toBe(false);
    expect(validateSourcePage(pageWith([record]))).toBeNull();
    expect(parseParserResponse(framed(pageWith([record])))).toBeNull();
  });

  it.each(required)(
    "rejects a %s record with a wrong-typed %s",
    (kind, field) => {
      const record = { ...RECORDS[kind]!, [field]: { wrong: true } };
      expect(validNormalizedRecord(record)).toBe(false);
      expect(validateSourcePage(pageWith([record]))).toBeNull();
      expect(parseParserResponse(framed(pageWith([record])))).toBeNull();
    },
  );

  it.each([
    ["a bad provider", { provider: "other" }],
    ["a non-finite event time", { eventTimeMs: Number.POSITIVE_INFINITY }],
    ["an empty dedupe key", { dedupeKey: "" }],
    ["a bad role", { role: "system" }],
    ["a numeric text", { text: 4 }],
  ])("rejects a message record with %s", (_name, patch) => {
    const record = { ...RECORDS.message, ...patch };
    expect(validNormalizedRecord(record)).toBe(false);
  });

  it("rejects a tool call whose touches are malformed and a usage record with a bad counter", () => {
    const call = RECORDS.tool_call!;
    expect(validNormalizedRecord({ ...call, touches: [{}] })).toBe(false);
    expect(
      validNormalizedRecord({
        ...call,
        touches: [{ path: "/a", access: "delete", confidence: "structured" }],
      }),
    ).toBe(false);
    expect(validNormalizedRecord({ ...USAGE_RECORD, inputTokens: -1 })).toBe(
      false,
    );
    expect(validNormalizedRecord({ ...USAGE_RECORD, basis: "other" })).toBe(
      false,
    );
  });

  it("accepts a valid placeholder and rejects a malformed one", () => {
    const placeholder = {
      kind: "oversized_record",
      dedupeKey: "oversized:1:0",
      startOffset: 0,
      endOffset: 5,
      byteLength: 5,
      reason: "record_too_large",
    };
    expect(
      validateSourcePage(pageWith([RECORDS.message], [placeholder])),
    ).not.toBeNull();
    expect(validateSourcePage(pageWith([], [{}]))).toBeNull();
    expect(
      validateSourcePage(pageWith([], [{ ...placeholder, byteLength: "x" }])),
    ).toBeNull();
    expect(validateSourcePage(pageWith([], ["placeholder"]))).toBeNull();
  });

  it.each([
    ["claude", "claude/session-main.jsonl"],
    ["codex", "codex/rollout.jsonl"],
  ] as const)(
    "accepts every page the real %s adapter produces for its fixture",
    async (provider, fixture) => {
      const source = {
        ref: { key: fixture, generation: 1, discoveredAtMs: 1 },
        path: fixturePath(fixture),
      };
      let cursor: string | null = null;
      let records = 0;
      for (let guard = 0; guard < 100; guard += 1) {
        const page = await DEFAULT_PARSER_READERS[provider](source, cursor);
        if (page.status !== "page") break;
        const wire = JSON.parse(JSON.stringify(page)) as unknown;
        expect(validateSourcePage(wire)).not.toBeNull();
        records += page.batch.records.length;
        cursor = page.cursor.next;
        if (page.progress.endOfFile) break;
      }
      expect(records).toBeGreaterThan(0);
    },
  );
});

describe("source binding", () => {
  it("names a mismatch of key, generation, discovery time and cursor", () => {
    const page = validateSourcePage(fullPage())!;
    const ref = { key: "a", generation: 1, discoveredAtMs: 1 };
    expect(pageBindingViolation(page, ref, null)).toBeNull();
    expect(pageBindingViolation(page, { ...ref, key: "b" }, null)).toContain(
      "a@1",
    );
    expect(
      pageBindingViolation(page, { ...ref, generation: 2 }, null),
    ).not.toBeNull();
    expect(
      pageBindingViolation(page, { ...ref, discoveredAtMs: 2 }, null),
    ).not.toBeNull();
    expect(pageBindingViolation(page, ref, "c0")).toContain("cursor");
  });

  it("quarantines a source whose page names another source and commits nothing", async () => {
    const clock = new Clock();
    const sink = new FakeSink();
    const events: SchedulerEvent[] = [];
    const parser: ParserHandle = {
      label: "cross",
      async read(input: ParserReadInput): Promise<ParserOutcome> {
        if (input.source.ref.key === "good") {
          const good = pageOutcome("c1", true, input.cursor) as unknown as {
            page: { batch: { source: unknown } };
          };
          good.page.batch.source = input.source.ref;
          return good as unknown as ParserOutcome;
        }
        const outcome = pageOutcome("c1", true, input.cursor) as {
          kind: "page";
          page: { batch: { source: unknown } };
        };
        outcome.page.batch.source = {
          ...input.source.ref,
          key: "good",
        };
        return outcome as unknown as ParserOutcome;
      },
      async close(): Promise<void> {},
    };
    const scheduler = new ParserScheduler({
      parsers: [parser],
      sink,
      clock: clock.read,
      onEvent: (event) => events.push(event),
    });
    scheduler.upsert(spec("bad"));
    scheduler.upsert(spec("good"));
    await scheduler.drain();
    expect(scheduler.state("bad")?.status).toBe("quarantined");
    expect(scheduler.state("bad")?.reason).toContain("protocol_violation");
    expect(sink.commits).toEqual(["good"]);
  });
});

class GateSink implements CommitSink {
  readonly inner = new FakeSink();
  readonly started: string[] = [];
  readonly finished: string[] = [];
  private readonly gates: Array<() => void> = [];
  blockFirst = true;

  cursor(ref: { key: string }): string | null {
    return this.inner.cursor(ref);
  }

  async commit(
    batch: { source: { key: string; generation: number } },
    update: { expected: string | null; next: string },
    fence: () => boolean,
  ): Promise<CommitResult> {
    const label = `${batch.source.key}@${batch.source.generation}`;
    this.started.push(label);
    if (this.blockFirst && this.started.length === 1) {
      await new Promise<void>((resolve) => this.gates.push(resolve));
    }
    const result = this.inner.commit(batch, update, fence);
    if (result.committed) this.finished.push(label);
    return result;
  }

  release(): void {
    for (const gate of this.gates.splice(0)) gate();
  }
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 5));
}

describe("generation fence at write time", () => {
  function gated() {
    const clock = new Clock();
    const parsers = [0, 1].map(
      (index) => new ScriptedParser(`p${index}`, clock),
    );
    const sink = new GateSink();
    const scheduler = new ParserScheduler({
      parsers,
      sink,
      clock: clock.read,
    });
    let openB: () => void = () => undefined;
    const holdB = new Promise<void>((resolve) => {
      openB = resolve;
    });
    parsers[1]!.script("b", [
      {
        cost: 1,
        outcome: async () => {
          await holdB;
          return pageOutcome("c1", true);
        },
      },
    ]);
    return { clock, parsers, sink, scheduler, openB };
  }

  function forKey(entries: string[], key: string): string[] {
    return entries.filter((entry) => entry.startsWith(`${key}@`));
  }

  it("persists nothing from an older generation that was replaced while its commit was in flight", async () => {
    const { parsers, sink, scheduler, openB } = gated();
    parsers[0]!.script("a", chain(1, 1));
    parsers[1]!.script("a", chain(1, 1));
    scheduler.upsert(spec("a", 1));
    scheduler.upsert(spec("b", 1));
    const drained = scheduler.drain();
    await tick();
    expect(forKey(sink.started, "a")).toEqual(["a@1"]);
    scheduler.upsert(spec("a", 2));
    openB();
    await tick();
    await tick();
    expect(forKey(sink.started, "a")).toEqual(["a@1"]);
    expect(
      parsers[1]!.reads.map((read) => read.source.ref.generation),
    ).toContain(2);
    sink.release();
    await drained;
    expect(forKey(sink.started, "a")).toEqual(["a@1", "a@2"]);
    expect(forKey(sink.finished, "a")).toEqual(["a@2"]);
    expect(scheduler.state("a")?.spec.ref.generation).toBe(2);
    expect(scheduler.state("a")?.status).toBe("idle");
  });

  it("skips a queued commit whose generation was replaced before it started", async () => {
    const { parsers, sink, scheduler, openB } = gated();
    parsers[0]!.script("a", [...chain(1, 1), ...chain(1, 1)]);
    parsers[1]!.script("a", [...chain(1, 1), ...chain(1, 1)]);
    scheduler.upsert(spec("a", 1));
    scheduler.upsert(spec("b", 1));
    const drained = scheduler.drain();
    await tick();
    scheduler.upsert(spec("a", 2));
    openB();
    await tick();
    await tick();
    scheduler.upsert(spec("a", 3));
    await tick();
    sink.release();
    await drained;
    expect(forKey(sink.started, "a")).not.toContain("a@2");
    expect(forKey(sink.finished, "a")).toEqual(["a@3"]);
    expect(scheduler.state("a")?.spec.ref.generation).toBe(3);
  });

  it("persists nothing from a source that was removed while its commit was in flight", async () => {
    const { parsers, sink, scheduler, openB } = gated();
    parsers[0]!.script("a", chain(1, 1));
    parsers[1]!.script("a", chain(1, 1));
    scheduler.upsert(spec("a", 1));
    scheduler.upsert(spec("b", 1));
    const drained = scheduler.drain();
    await tick();
    expect(forKey(sink.started, "a")).toEqual(["a@1"]);
    scheduler.remove("a");
    openB();
    sink.release();
    await drained;
    expect(forKey(sink.finished, "a")).toEqual([]);
    expect(sink.inner.commits).not.toContain("a");
    expect(sink.inner.cursor({ key: "a" })).toBeNull();
    expect(scheduler.state("a")).toBeNull();
  });
});

describe("cursor read failures", () => {
  it("defers a source whose stored cursor cannot be read and recovers", async () => {
    const { clock, parsers, sink, scheduler, events } = harness({});
    let failures = 2;
    sink.cursor = (ref: { key: string }) => {
      if (failures > 0) {
        failures -= 1;
        throw new Error("cursor read failed");
      }
      return sink.cursors.get(ref.key) ?? null;
    };
    parsers[0]!.script("a", chain(1, 1));
    parsers[0]!.script("b", chain(1, 1));
    scheduler.upsert(spec("a"));
    scheduler.upsert(spec("b"));
    await scheduler.drain();
    expect(events.map((event) => event.type)).toContain("deferred");
    expect(events.find((event) => event.type === "deferred")?.detail).toContain(
      "cursor read failed",
    );
    await settle(scheduler, clock);
    expect(sink.commits.sort()).toEqual(["a", "b"]);
    expect(scheduler.state("a")?.status).toBe("idle");
    expect(scheduler.state("b")?.status).toBe("idle");
  });

  it("defers a source whose cursor read rejects asynchronously", async () => {
    const { clock, parsers, sink, scheduler } = harness({});
    let failed = false;
    (sink as unknown as { cursor: unknown }).cursor = async (ref: {
      key: string;
    }) => {
      if (!failed) {
        failed = true;
        throw new Error("async cursor failure");
      }
      return sink.cursors.get(ref.key) ?? null;
    };
    parsers[0]!.script("a", chain(1, 1));
    scheduler.upsert(spec("a"));
    await scheduler.drain();
    expect(scheduler.state("a")?.status).toBe("deferred");
    expect(scheduler.state("a")?.reason).toContain("async cursor failure");
    await settle(scheduler, clock);
    expect(sink.commits).toEqual(["a"]);
  });
});

describe("sink failure bound", () => {
  it("backs off with a doubling delay and quarantines after the failure limit", async () => {
    const { clock, parsers, sink, scheduler, events } = harness({
      maxSinkFailures: 3,
      deferBackoffMs: 100,
    });
    parsers[0]!.script("a", chain(10, 1, false));
    sink.refusals.set("a", ["throw", "throw", "throw", "throw"]);
    scheduler.upsert(spec("a"));
    await scheduler.drain();
    expect(scheduler.state("a")?.status).toBe("deferred");
    expect(scheduler.nextWakeAtMs()! - clock.now).toBe(100);
    clock.now = scheduler.nextWakeAtMs()!;
    await scheduler.drain();
    expect(scheduler.state("a")?.status).toBe("deferred");
    expect(scheduler.nextWakeAtMs()! - clock.now).toBe(200);
    clock.now = scheduler.nextWakeAtMs()!;
    await scheduler.drain();
    expect(scheduler.state("a")?.status).toBe("quarantined");
    expect(scheduler.state("a")?.reason).toContain("commit_failed");
    expect(scheduler.state("a")?.reason).toContain("sink exploded");
    expect(scheduler.nextWakeAtMs()).toBeNull();
    expect(sink.commits).toEqual([]);
    expect(events.filter((event) => event.type === "deferred")).toHaveLength(2);
    expect(events.map((event) => event.type)).toContain("quarantined");
  });

  it("keeps indexing other sources while one commit keeps failing", async () => {
    const { clock, parsers, sink, scheduler } = harness({
      maxSinkFailures: 2,
      deferBackoffMs: 10,
    });
    parsers[0]!.script("a", chain(5, 1, false));
    parsers[0]!.script("b", chain(2, 1));
    sink.refusals.set("a", ["throw", "throw"]);
    scheduler.upsert(spec("a"));
    scheduler.upsert(spec("b"));
    await settle(scheduler, clock);
    expect(scheduler.state("a")?.status).toBe("quarantined");
    expect(scheduler.state("b")?.status).toBe("idle");
    expect(sink.commits).toEqual(["b", "b"]);
  });

  it("resets the count after a commit succeeds", async () => {
    const { clock, parsers, sink, scheduler } = harness({
      maxSinkFailures: 3,
      deferBackoffMs: 10,
    });
    parsers[0]!.script("a", chain(8, 1));
    const original = sink.commit.bind(sink);
    let calls = 0;
    sink.commit = (batch, update, fence) => {
      calls += 1;
      if ([1, 2, 4, 5].includes(calls)) throw new Error("sink exploded");
      return original(batch, update, fence);
    };
    scheduler.upsert(spec("a"));
    await settle(scheduler, clock, 40);
    expect(scheduler.state("a")?.status).toBe("idle");
    expect(sink.commits.length).toBeGreaterThan(0);
  });

  it("retries a quarantined source when its generation changes", async () => {
    const { clock, parsers, sink, scheduler } = harness({
      maxSinkFailures: 2,
      deferBackoffMs: 10,
    });
    parsers[0]!.script("a", chain(3, 1));
    sink.refusals.set("a", ["throw", "throw"]);
    scheduler.upsert(spec("a"));
    await settle(scheduler, clock);
    expect(scheduler.state("a")?.status).toBe("quarantined");
    parsers[0]!.script("a", chain(1, 1));
    scheduler.upsert(spec("a", 2));
    await settle(scheduler, clock);
    expect(scheduler.state("a")?.status).toBe("idle");
    expect(sink.commits).toEqual(["a"]);
  });

  it("bounds a cursor read that keeps failing and still serves other sources", async () => {
    const { clock, parsers, sink, scheduler } = harness({
      maxSinkFailures: 3,
      deferBackoffMs: 100,
    });
    sink.cursor = (ref: { key: string }) => {
      if (ref.key === "a") throw new Error("cursor read failed");
      return sink.cursors.get(ref.key) ?? null;
    };
    parsers[0]!.script("a", chain(2, 1));
    parsers[0]!.script("b", chain(1, 1));
    scheduler.upsert(spec("a"));
    scheduler.upsert(spec("b"));
    await scheduler.drain();
    expect(scheduler.nextWakeAtMs()).toBe(100);
    await settle(scheduler, clock);
    expect(scheduler.state("a")?.status).toBe("quarantined");
    expect(scheduler.state("a")?.reason).toContain("cursor_failed");
    expect(scheduler.state("b")?.status).toBe("idle");
    expect(sink.commits).toEqual(["b"]);
    expect(parsers[0]!.reads.some((read) => read.source.ref.key === "a")).toBe(
      false,
    );
  });

  it("does not count a known refusal as a sink failure", async () => {
    const { clock, parsers, sink, scheduler } = harness({
      maxSinkFailures: 2,
      deferBackoffMs: 10,
    });
    parsers[0]!.script("a", chain(1, 1));
    sink.refusals.set("a", ["db_capacity", "db_capacity", "db_capacity"]);
    scheduler.upsert(spec("a"));
    await settle(scheduler, clock);
    expect(scheduler.state("a")?.status).toBe("idle");
  });
});

describe("restart backoff", () => {
  it("waits restartBackoffMs before the first retry and doubles up to the cap", async () => {
    const clock = new Clock();
    const parser = new ScriptedParser("p0", clock);
    const sink = new FakeSink();
    const events: SchedulerEvent[] = [];
    const scheduler = new ParserScheduler({
      parsers: [parser],
      sink,
      clock: clock.read,
      maxTerminations: 5,
      restartBackoffMs: 100,
      restartBackoffMaxMs: 250,
      onEvent: (event) => events.push(event),
    });
    const crash: Step = {
      cost: 0,
      outcome: {
        kind: "terminated",
        cause: "crash",
        message: "crash: code 70",
      },
    };
    parser.script("a", [crash, crash, crash, crash, crash]);
    scheduler.upsert(spec("a"));
    const wakes: number[] = [];
    for (let round = 0; round < 5; round += 1) {
      await scheduler.drain();
      const wake = scheduler.nextWakeAtMs();
      if (wake === null) break;
      wakes.push(wake - clock.now);
      expect(parser.reads).toHaveLength(round + 1);
      clock.now = wake - 1;
      await scheduler.drain();
      expect(parser.reads).toHaveLength(round + 1);
      clock.now = wake;
    }
    expect(wakes).toEqual([100, 200, 250, 250]);
    expect(scheduler.state("a")?.status).toBe("suspended");
  });
});
