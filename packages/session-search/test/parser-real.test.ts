import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { readFileSync } from "node:fs";
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
const gates: Array<{ pidLog: string; release: (pids: number[]) => void }> = [];
const QUIET_DEADLINE_MS = 120_000;
const RETIRE_GRACE_MS = 600_000;

afterEach(async () => {
  for (const gate of gates.splice(0)) {
    gate.release(allPids(gate.pidLog));
  }
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
    env?: NodeJS.ProcessEnv;
    idleExitMs?: number;
    closeGraceMs?: number;
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
        env: options.env,
        admissionWaitMs: 2_000,
        idleExitMs: options.idleExitMs ?? 0,
        closeGraceMs: options.closeGraceMs,
      }),
  );
  const events: SchedulerEvent[] = [];
  const scheduler = new ParserScheduler({
    parsers: slots,
    sink: storeSink(store),
    clock: () => Date.now(),
    stallMs: options.stallMs ?? QUIET_DEADLINE_MS,
    quantumMs: options.quantumMs,
    unreadableBackoffMs: 50,
    unreadableBackoffMaxMs: 200,
    deferBackoffMs: 50,
    restartBackoffMs: 50,
    restartBackoffMaxMs: 200,
    onEvent: (event) => events.push(event),
  });
  const built = { dir, store, supervisor, slots, scheduler, events, files };
  rigs.push(built);
  return built;
}

async function settle(built: Rig, rounds = 20): Promise<void> {
  for (let round = 0; round < rounds; round += 1) {
    await built.scheduler.drain();
    const wake = built.scheduler.nextWakeAtMs();
    if (wake === null) return;
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(0, wake - Date.now()) + 5),
    );
  }
}

function alivePids(log: string): number[] {
  let raw = "";
  try {
    raw = readFileSync(log, "utf8");
  } catch {
    return [];
  }
  return raw
    .split("\n")
    .filter((entry) => entry !== "")
    .map(Number)
    .filter((pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    });
}

function allPids(log: string): number[] {
  try {
    return readFileSync(log, "utf8")
      .split("\n")
      .filter((entry) => entry !== "")
      .map(Number);
  } catch {
    return [];
  }
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const DETECTION_WINDOW_MS = 300;

function lingerGate(): {
  env: NodeJS.ProcessEnv;
  pidLog: string;
  lingering: (count: number) => Promise<void>;
  release: (pids: number[]) => void;
} {
  const base = mkdtempSync(join(tmpdir(), "ss-parser-gate-"));
  temps.push(base);
  const pidLog = join(base, "pids");
  const eventLog = join(base, "events");
  const releaseDir = join(base, "release");
  mkdirSync(releaseDir);
  const release = (pids: number[]): void => {
    for (const pid of pids) {
      writeFileSync(join(releaseDir, String(pid)), "");
    }
  };
  gates.push({ pidLog, release });
  return {
    pidLog,
    env: {
      ...process.env,
      PARSER_CHILD_PID_LOG: pidLog,
      PARSER_CHILD_EVENT_LOG: eventLog,
      PARSER_CHILD_RELEASE_DIR: releaseDir,
    },
    lingering: async (count) => {
      const deadline = Date.now() + 30_000;
      for (;;) {
        let raw = "";
        try {
          raw = readFileSync(eventLog, "utf8");
        } catch {
          raw = "";
        }
        const seen = raw.split("\n").filter((entry) => entry !== "").length;
        if (seen >= count) return;
        if (Date.now() > deadline) {
          throw new Error(`only ${seen} of ${count} children lingered`);
        }
        await pause(5);
      }
    },
    release,
  };
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
    const built = rig({ stallMs: 10_000 });
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
    await settle(built);
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
    await settle(built);
    expect(built.scheduler.state("a.crash.jsonl")?.status).toBe("suspended");
    built.scheduler.upsert(crashing);
    await settle(built);
    expect(built.scheduler.state("a.crash.jsonl")?.status).toBe("suspended");
    const reads = built.events.filter((e) => e.type === "retry").length;
    built.scheduler.upsert({
      ...crashing,
      ref: { ...crashing.ref, generation: 2 },
    });
    await settle(built);
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
      await settle(built);
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

  it("quarantines a page without progress, kills the child and indexes the next source", async () => {
    const built = rig();
    built.scheduler.upsert(session(built, "a.nopage.jsonl"));
    built.scheduler.upsert(session(built, "b.jsonl"));
    await built.scheduler.drain();
    expect(built.scheduler.state("a.nopage.jsonl")?.status).toBe("quarantined");
    expect(built.scheduler.state("a.nopage.jsonl")?.reason).toContain(
      "protocol_violation",
    );
    expect(built.scheduler.state("b.jsonl")?.status).toBe("idle");
    expect(texts(built.dir)).toEqual([
      "b.jsonl message 0",
      "b.jsonl message 1",
      "b.jsonl message 2",
    ]);
  }, 60_000);

  it("quarantines a response that names another source and writes nothing for it", async () => {
    const built = rig();
    built.scheduler.upsert(session(built, "a.cross.jsonl"));
    built.scheduler.upsert(session(built, "b.jsonl"));
    await built.scheduler.drain();
    expect(built.scheduler.state("a.cross.jsonl")?.status).toBe("quarantined");
    expect(built.scheduler.state("a.cross.jsonl")?.reason).toContain(
      "other-session.jsonl",
    );
    expect(built.scheduler.state("b.jsonl")?.status).toBe("idle");
    expect(count(built.dir, "content")).toBe(3);
    expect(texts(built.dir).some((text) => text.startsWith("a.cross"))).toBe(
      false,
    );
  }, 60_000);

  const MALFORMED_VARIANTS = [
    "empty",
    ...[
      "dedupeKey",
      "provider",
      "kind",
      "sessionId",
      "agentId",
      "parentCallId",
      "cwd",
      "sidechain",
      "eventTimeMs",
      "role",
      "text",
    ].flatMap((field) => [`missing-${field}`, `wrongtype-${field}`]),
  ];

  it.each(MALFORMED_VARIANTS)(
    "kills the child and quarantines the generation for a malformed record (%s)",
    async (variant) => {
      const gate = lingerGate();
      const built = rig({ env: gate.env });
      const name = `a.badrecord-${variant}.jsonl`;
      built.scheduler.upsert(session(built, name));
      built.scheduler.upsert(session(built, "b.jsonl"));
      await built.scheduler.drain();
      const state = built.scheduler.state(name);
      expect(state?.status).toBe("quarantined");
      expect(state?.reason).toContain("protocol_violation");
      expect(built.scheduler.state("b.jsonl")?.status).toBe("idle");
      expect(texts(built.dir)).toEqual([
        "b.jsonl message 0",
        "b.jsonl message 1",
        "b.jsonl message 2",
      ]);
      expect(
        built.events.filter((e) => e.type === "retry" && e.key === name),
      ).toHaveLength(0);
      const offender = allPids(gate.pidLog)[0]!;
      const deadline = Date.now() + 30_000;
      while (alivePids(gate.pidLog).includes(offender)) {
        if (Date.now() > deadline) throw new Error("offending child survived");
        await pause(5);
      }
    },
    60_000,
  );

  it("waits for a retiring child to die before it starts the next one", async () => {
    const gate = lingerGate();
    const built = rig({
      idleExitMs: 30,
      env: gate.env,
      closeGraceMs: RETIRE_GRACE_MS,
    });
    const slot = built.slots[0]!;
    const read = async (name: string) =>
      slot.read({ source: session(built, name), cursor: null, stallMs: 5_000 });
    expect((await read("a.jsonl")).kind).toBe("page");
    const first = alivePids(gate.pidLog);
    expect(first).toHaveLength(1);
    await gate.lingering(1);
    expect(alivePids(gate.pidLog)).toEqual(first);
    let settled = false;
    const next = read("b.jsonl").then((outcome) => {
      settled = true;
      return outcome;
    });
    await pause(DETECTION_WINDOW_MS);
    expect(settled).toBe(false);
    expect(alivePids(gate.pidLog)).toEqual(first);
    gate.release(first);
    expect((await next).kind).toBe("page");
    expect(alivePids(gate.pidLog)).toHaveLength(1);
    expect(alivePids(gate.pidLog)).not.toEqual(first);
  }, 60_000);

  it("never holds more than one live child per slot while slots retire and restart", async () => {
    const gate = lingerGate();
    const built = rig({
      parsers: 2,
      idleExitMs: 30,
      env: gate.env,
      closeGraceMs: RETIRE_GRACE_MS,
    });
    let peak = 0;
    const sampler = setInterval(() => {
      peak = Math.max(peak, alivePids(gate.pidLog).length);
    }, 10);
    const round = (index: number) =>
      Promise.all(
        built.slots.map((slot, slotIndex) =>
          slot.read({
            source: session(built, `r${index}-${slotIndex}.jsonl`),
            cursor: null,
            stallMs: 5_000,
          }),
        ),
      );
    try {
      let outcomes = await round(0);
      expect(outcomes.map((outcome) => outcome.kind)).toEqual(["page", "page"]);
      for (let index = 1; index < 3; index += 1) {
        await gate.lingering(index * 2);
        const retiring = alivePids(gate.pidLog);
        const next = round(index);
        await pause(DETECTION_WINDOW_MS);
        expect(alivePids(gate.pidLog)).toEqual(retiring);
        gate.release(retiring);
        outcomes = await next;
        expect(outcomes.map((outcome) => outcome.kind)).toEqual([
          "page",
          "page",
        ]);
      }
    } finally {
      clearInterval(sampler);
    }
    expect(peak).toBeGreaterThanOrEqual(1);
    expect(peak).toBeLessThanOrEqual(2);
  }, 60_000);

  it("waits for a retiring child when the slot is closed", async () => {
    const gate = lingerGate();
    const built = rig({
      idleExitMs: 30,
      env: gate.env,
      closeGraceMs: RETIRE_GRACE_MS,
    });
    const slot = built.slots[0]!;
    expect(
      (
        await slot.read({
          source: session(built, "a.jsonl"),
          cursor: null,
          stallMs: 5_000,
        })
      ).kind,
    ).toBe("page");
    await gate.lingering(1);
    const retiring = alivePids(gate.pidLog);
    expect(retiring).toHaveLength(1);
    let closed = false;
    const closing = slot.close().then(() => {
      closed = true;
    });
    await pause(DETECTION_WINDOW_MS);
    expect(closed).toBe(false);
    expect(alivePids(gate.pidLog)).toEqual(retiring);
    gate.release(retiring);
    await closing;
    expect(alivePids(gate.pidLog)).toHaveLength(0);
  }, 60_000);

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
