import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  MemorySupervisor,
  ParserScheduler,
  ParserSlot,
  osRssSupported,
  storeSink,
  type ParserSourceSpec,
  type SchedulerEvent,
} from "../src/index.js";
import {
  openReadonlyConnection,
  type SessionSearchStore,
  type SourceRef,
} from "../src/storage.js";
import {
  cleanupStoreDirs,
  makeStoreDir,
  openTestStore,
} from "./support/store-helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const packageDir = join(here, "..");
const childScript = join(here, "support", "parser-child.ts");
const CHILD_ARGS = ["--import", "tsx", childScript];
const supported = osRssSupported();

interface Rig {
  dir: string;
  store: SessionSearchStore;
  supervisor: MemorySupervisor;
  slots: ParserSlot[];
  scheduler: ParserScheduler;
  events: SchedulerEvent[];
  files: string;
}

const rigs: Rig[] = [];
const temps: string[] = [];

afterEach(async () => {
  for (const rig of rigs.splice(0)) {
    await Promise.all(rig.slots.map((slot) => slot.close()));
    rig.supervisor.dispose();
    rig.store.close();
  }
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  cleanupStoreDirs();
});

function rig(
  options: {
    parsers?: number;
    stallMs?: number;
    quantumMs?: number;
    command?: string;
  } = {},
): Rig {
  const dir = makeStoreDir("ss-parser-");
  const store = openTestStore(dir);
  const files = mkdtempSync(join(tmpdir(), "ss-parser-files-"));
  temps.push(files);
  const supervisor = new MemorySupervisor();
  const slots = Array.from(
    { length: options.parsers ?? 1 },
    (_, index) =>
      new ParserSlot({
        label: `parser-${index}`,
        supervisor,
        args: CHILD_ARGS,
        command: options.command,
        cwd: packageDir,
        admissionWaitMs: 2_000,
        idleExitMs: 0,
      }),
  );
  const events: SchedulerEvent[] = [];
  const scheduler = new ParserScheduler({
    parsers: slots,
    sink: storeSink(store),
    clock: () => Date.now(),
    stallMs: options.stallMs ?? 3_000,
    quantumMs: options.quantumMs,
    unreadableBackoffMs: 50,
    unreadableBackoffMaxMs: 200,
    deferBackoffMs: 50,
    onEvent: (event) => events.push(event),
  });
  const built = { dir, store, supervisor, slots, scheduler, events, files };
  rigs.push(built);
  return built;
}

function line(uuid: string, text: string): string {
  return JSON.stringify({
    type: "user",
    uuid,
    sessionId: "s1",
    timestamp: "2026-01-01T00:00:00.000Z",
    cwd: "/work/fixture",
    message: { role: "user", content: text },
  });
}

function session(
  built: Rig,
  name: string,
  generation = 1,
  messages = 3,
): ParserSourceSpec {
  const path = join(built.files, name);
  mkdirSync(dirname(path), { recursive: true });
  const lines = Array.from({ length: messages }, (_, index) =>
    line(`${name}-${index}`, `${name} message ${index}`),
  );
  writeFileSync(path, lines.join("\n") + "\n");
  const ref: SourceRef = { key: name, generation, discoveredAtMs: 1 };
  return { ref, provider: "claude", path };
}

function count(dir: string, table: string): number {
  const db = openReadonlyConnection(dir);
  try {
    return (
      db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }
    ).n;
  } finally {
    db.close();
  }
}

function texts(dir: string): string[] {
  const db = openReadonlyConnection(dir);
  try {
    return (
      db.prepare("SELECT text FROM content ORDER BY id").all() as Array<{
        text: string;
      }>
    ).map((row) => row.text);
  } finally {
    db.close();
  }
}

describe("real parser children", () => {
  it("indexes a session through a real child, the real adapter and the real store", async () => {
    const built = rig();
    built.scheduler.upsert(session(built, "alpha.jsonl"));
    await built.scheduler.drain();
    expect(built.scheduler.state("alpha.jsonl")?.status).toBe("idle");
    expect(count(built.dir, "content")).toBe(3);
    expect(texts(built.dir)).toContain("alpha.jsonl message 0");
  }, 60_000);

  it("quarantines a stalled session and still indexes the next good session", async () => {
    const built = rig({ stallMs: 1_500 });
    built.scheduler.upsert(session(built, "a.stall.jsonl"));
    built.scheduler.upsert(session(built, "b.jsonl"));
    await built.scheduler.drain();
    expect(built.scheduler.state("a.stall.jsonl")?.status).toBe("quarantined");
    expect(built.scheduler.state("a.stall.jsonl")?.reason).toContain("stalled");
    expect(built.scheduler.state("b.jsonl")?.status).toBe("idle");
    expect(texts(built.dir)).toContain("b.jsonl message 2");
    expect(texts(built.dir).some((text) => text.startsWith("a.stall"))).toBe(
      false,
    );
  }, 60_000);

  it("rejects a 64 MiB frame header, quarantines the session and indexes the next one", async () => {
    const built = rig();
    built.scheduler.upsert(session(built, "a.violate.jsonl"));
    built.scheduler.upsert(session(built, "b.jsonl"));
    await built.scheduler.drain();
    expect(built.scheduler.state("a.violate.jsonl")?.status).toBe(
      "quarantined",
    );
    expect(built.scheduler.state("b.jsonl")?.status).toBe("idle");
    expect(count(built.dir, "content")).toBe(3);
  }, 60_000);

  it("turns a response frame that is too large into a quarantine, not a crash", async () => {
    const built = rig();
    built.scheduler.upsert(session(built, "a.huge.jsonl"));
    built.scheduler.upsert(session(built, "b.jsonl"));
    await built.scheduler.drain();
    expect(built.scheduler.state("a.huge.jsonl")?.status).toBe("quarantined");
    expect(built.scheduler.state("a.huge.jsonl")?.reason).toContain(
      "page_too_large",
    );
    expect(built.scheduler.state("b.jsonl")?.status).toBe("idle");
    expect(count(built.dir, "content")).toBe(3);
  }, 60_000);

  it("restarts a crashed parser, suspends the source on the second crash and indexes the others", async () => {
    const built = rig();
    built.scheduler.upsert(session(built, "a.crash.jsonl"));
    built.scheduler.upsert(session(built, "b.jsonl"));
    built.scheduler.upsert(session(built, "c.jsonl"));
    await built.scheduler.drain();
    expect(built.scheduler.state("a.crash.jsonl")?.status).toBe("suspended");
    expect(built.scheduler.state("b.jsonl")?.status).toBe("idle");
    expect(built.scheduler.state("c.jsonl")?.status).toBe("idle");
    expect(count(built.dir, "content")).toBe(6);
    expect(built.events.map((e) => e.type)).toContain("retry");
    expect(built.events.map((e) => e.type)).toContain("suspended");
  }, 60_000);

  it("retries a suspended source after its generation changes", async () => {
    const built = rig();
    const crashing = session(built, "a.crash.jsonl");
    built.scheduler.upsert(crashing);
    await built.scheduler.drain();
    expect(built.scheduler.state("a.crash.jsonl")?.status).toBe("suspended");
    built.scheduler.upsert(crashing);
    await built.scheduler.drain();
    expect(built.scheduler.state("a.crash.jsonl")?.status).toBe("suspended");
    const reads = built.events.filter((e) => e.type === "retry").length;
    built.scheduler.upsert({
      ...crashing,
      ref: { ...crashing.ref, generation: 2 },
    });
    await built.scheduler.drain();
    expect(built.events.filter((e) => e.type === "retry").length).toBe(
      reads + 1,
    );
    expect(built.scheduler.state("a.crash.jsonl")?.status).toBe("suspended");
  }, 60_000);

  it.skipIf(process.getuid?.() === 0)(
    "skips an unreadable source without stopping the others",
    async () => {
      const built = rig();
      const locked = session(built, "locked.jsonl");
      chmodSync(locked.path, 0o000);
      built.scheduler.upsert(locked);
      built.scheduler.upsert(session(built, "a.jsonl"));
      built.scheduler.upsert(session(built, "b.jsonl"));
      await built.scheduler.drain();
      expect(built.scheduler.state("locked.jsonl")?.status).toBe("unreadable");
      expect(built.scheduler.state("locked.jsonl")?.reason).toContain("EACCES");
      expect(built.scheduler.state("a.jsonl")?.status).toBe("idle");
      expect(built.scheduler.state("b.jsonl")?.status).toBe("idle");
      expect(count(built.dir, "content")).toBe(6);
      chmodSync(locked.path, 0o644);
      await new Promise((resolve) => setTimeout(resolve, 250));
      await built.scheduler.drain();
      expect(built.scheduler.state("locked.jsonl")?.status).toBe("idle");
      expect(count(built.dir, "content")).toBe(9);
    },
    60_000,
  );

  it("reports a missing source as invalidated, not as a failure of the others", async () => {
    const built = rig();
    built.scheduler.upsert({
      ref: { key: "missing.jsonl", generation: 1, discoveredAtMs: 1 },
      provider: "claude",
      path: join(built.files, "missing.jsonl"),
    });
    built.scheduler.upsert(session(built, "a.jsonl"));
    await built.scheduler.drain();
    expect(built.scheduler.state("missing.jsonl")?.status).toBe("invalidated");
    expect(built.scheduler.state("a.jsonl")?.status).toBe("idle");
    expect(count(built.dir, "content")).toBe(3);
  }, 60_000);

  it("spreads sources over two parser children", async () => {
    const built = rig({ parsers: 2 });
    for (const name of ["a", "b", "c", "d"]) {
      built.scheduler.upsert(session(built, `${name}.jsonl`));
    }
    await built.scheduler.drain();
    expect(count(built.dir, "content")).toBe(12);
    expect(built.scheduler.states().every((s) => s.status === "idle")).toBe(
      true,
    );
  }, 60_000);

  it("reports a parser that cannot start as a termination", async () => {
    const built = rig({ command: join(tmpdir(), "no-such-parser-binary") });
    const outcome = await built.slots[0]!.read({
      source: session(built, "a.jsonl"),
      cursor: null,
      stallMs: 1_000,
    });
    expect(outcome.kind).toBe("terminated");
  }, 30_000);

  it("refuses to read when memory admission fails", async () => {
    const dir = makeStoreDir("ss-parser-");
    const supervisor = new MemorySupervisor({
      limits: { reservationBudgetBytes: 1024 },
    });
    const slot = new ParserSlot({
      label: "tight",
      supervisor,
      args: CHILD_ARGS,
      cwd: packageDir,
      admissionWaitMs: 200,
      idleExitMs: 0,
    });
    const built: Rig = {
      dir,
      store: openTestStore(dir),
      supervisor,
      slots: [slot],
      scheduler: null as unknown as ParserScheduler,
      events: [],
      files: mkdtempSync(join(tmpdir(), "ss-parser-files-")),
    };
    temps.push(built.files);
    rigs.push(built);
    const outcome = await slot.read({
      source: session(built, "a.jsonl"),
      cursor: null,
      stallMs: 1_000,
    });
    expect(outcome.kind).toBe("refused");
  }, 30_000);

  it.skipIf(!supported)(
    "kills a parser that outgrows its memory limit, suspends that source and indexes the next",
    async () => {
      const built = rig({ stallMs: 20_000 });
      built.scheduler.upsert(session(built, "a.bloat.jsonl"));
      built.scheduler.upsert(session(built, "b.jsonl"));
      await built.scheduler.drain();
      expect(built.supervisor.kills().length).toBeGreaterThanOrEqual(1);
      expect(built.scheduler.state("a.bloat.jsonl")?.status).toBe("suspended");
      expect(built.scheduler.state("a.bloat.jsonl")?.reason).toContain(
        "memory_kill",
      );
      expect(built.scheduler.state("b.jsonl")?.status).toBe("idle");
      expect(texts(built.dir)).toContain("b.jsonl message 0");
    },
    120_000,
  );
});
