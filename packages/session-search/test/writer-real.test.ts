import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
  WriterSink,
  osRssSupported,
  type ParserSourceSpec,
} from "../src/index.js";
import { readProcessMemory } from "../src/ipc/rss.js";
import {
  childEnvironment,
  openReadonlyConnection,
  type CommitBatch,
  type CommitResult,
  type SourceRef,
} from "../src/storage.js";
import { WRITER_STORE_DIR_ENV } from "../src/writer/store.js";
import {
  batchOf,
  cleanupStoreDirs,
  makeStoreDir,
  message,
  openTestStore,
  source,
} from "./support/store-helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const packageDir = join(here, "..");
const writerScript = join(here, "support", "writer-child.ts");
const parserScript = join(here, "support", "parser-child.ts");
const productionScript = join(packageDir, "src", "writer", "child-main.ts");
const WRITER_ARGS = ["--import", "tsx", writerScript];
const PARSER_ARGS = ["--import", "tsx", parserScript];
const supported = osRssSupported();
const BASE_MS = 1_700_000_000_000;

interface Rig {
  dir: string;
  control: string;
  supervisor: MemorySupervisor;
  sink: WriterSink;
}

const rigs: Rig[] = [];
const slots: ParserSlot[] = [];
const temps: string[] = [];

afterEach(async () => {
  await Promise.all(slots.splice(0).map((slot) => slot.close()));
  for (const built of rigs.splice(0)) {
    await built.sink.close();
    built.supervisor.dispose();
  }
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  cleanupStoreDirs();
});

function rig(
  options: {
    production?: boolean;
    requestTimeoutMs?: number;
    cursorWaitMs?: number;
  } = {},
): Rig {
  const dir = makeStoreDir("ss-writer-");
  const control = mkdtempSync(join(tmpdir(), "ss-writer-control-"));
  temps.push(control);
  const supervisor = new MemorySupervisor();
  const env = options.production
    ? { ...childEnvironment(dir), [WRITER_STORE_DIR_ENV]: dir }
    : {
        ...process.env,
        [WRITER_STORE_DIR_ENV]: dir,
        WRITER_TEST_CONTROL_DIR: control,
      };
  const sink = new WriterSink({
    label: "writer",
    supervisor,
    args: options.production
      ? ["--import", "tsx", productionScript]
      : WRITER_ARGS,
    cwd: packageDir,
    env,
    requestTimeoutMs: options.requestTimeoutMs ?? 20_000,
    readyTimeoutMs: 30_000,
    cursorWaitMs: options.cursorWaitMs ?? 10_000,
    closeGraceMs: 2_000,
  });
  const built = { dir, control, supervisor, sink };
  rigs.push(built);
  return built;
}

function arm(built: Rig, name: string): void {
  writeFileSync(join(built.control, name), "");
}

function pids(built: Rig): number[] {
  try {
    return readFileSync(join(built.control, "pids.log"), "utf8")
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

async function until(
  condition: () => boolean | Promise<boolean>,
  limitMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + limitMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error("condition not reached");
    await pause(20);
  }
}

function messages(ref: SourceRef, count: number, tag = "m"): CommitBatch {
  return batchOf(
    ref,
    Array.from({ length: count }, (_, index) =>
      message(`${tag}${index}`, `${tag} witness ${index}`, BASE_MS + index),
    ),
  );
}

async function commitNow(
  built: Rig,
  batch: CommitBatch,
  next: string,
  token: string | null,
  fence: () => boolean = () => true,
): Promise<CommitResult> {
  const expected = await built.sink.cursor(batch.source);
  return await built.sink.commit(batch, { expected, next }, fence, token);
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

function ftsHits(dir: string, term: string): number {
  const db = openReadonlyConnection(dir);
  try {
    return (
      db
        .prepare(
          "SELECT count(*) AS n FROM content_fts WHERE content_fts MATCH ?",
        )
        .get(term) as { n: number }
    ).n;
  } finally {
    db.close();
  }
}

async function expectIntegrity(built: Rig): Promise<void> {
  await built.sink.close();
  const store = openTestStore(built.dir);
  try {
    const report = store.integrityCheck();
    expect(report.problems).toEqual([]);
    expect(report.ok).toBe(true);
  } finally {
    store.close();
  }
}

async function stateEventually(
  built: Rig,
): Promise<Awaited<ReturnType<WriterSink["state"]>>> {
  let last: unknown;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      return await built.sink.state();
    } catch (error) {
      last = error;
      await pause(50);
    }
  }
  throw last;
}

describe("writer child storage fence", () => {
  it("refuses a commit whose generation token is no longer current, inside the write transaction", () => {
    const dir = makeStoreDir("ss-fence-");
    const store = openTestStore(dir);
    try {
      const ref = source("fence-src", 1, BASE_MS);
      store.setFence({ key: ref.key, generation: 1, token: "t1" });
      const batch = messages(ref, 2);
      const first = store.commitBatch(
        batch,
        { expected: store.getCursor(ref), next: "c1" },
        undefined,
        { fenceToken: "t1" },
      );
      expect(first.committed).toBe(true);
      store.setFence({ key: ref.key, generation: 2, token: "t2" });
      const stale = store.commitBatch(
        messages(ref, 3, "late"),
        { expected: store.getCursor(ref), next: "c2" },
        () => true,
        { fenceToken: "t1" },
      );
      expect(stale.committed).toBe(false);
      expect(stale.refusal?.code).toBe("stale_generation");
      expect(store.getCursor(ref)).toBe("c1");
      expect(count(dir, "content")).toBe(2);
      store.clearFence(ref.key);
      const cleared = store.commitBatch(
        messages(ref, 1, "gone"),
        { expected: store.getCursor(ref), next: "c3" },
        () => true,
        { fenceToken: "t2" },
      );
      expect(cleared.refusal?.code).toBe("stale_generation");
      store.syncFences([{ key: ref.key, generation: 2, token: "t2" }]);
      expect(store.fenceOf(ref.key)).toBe("2:t2");
    } finally {
      store.close();
    }
  });
});

describe("real writer child", () => {
  it("commits through the production entry point and reads the cursor back", async () => {
    const built = rig({ production: true });
    const ref = source("prod", 1, BASE_MS);
    const token = built.sink.adopt(ref);
    const result = await commitNow(built, messages(ref, 3), "c1", token);
    expect(result.committed).toBe(true);
    expect(await built.sink.cursor(ref)).toBe("c1");
    expect(count(built.dir, "content")).toBe(3);
    expect(ftsHits(built.dir, "witness")).toBe(3);
    const state = await built.sink.state();
    expect(state.pressure.status).toBe("clear");
    expect(state.suspended).toBeNull();
    await expectIntegrity(built);
  }, 90_000);

  it("refuses a stale-generation commit that arrives after an upsert, although the in-process fence still passes", async () => {
    const built = rig();
    const ref = source("race", 1, BASE_MS);
    const oldToken = built.sink.adopt(ref);
    const ok = await commitNow(built, messages(ref, 2), "c1", oldToken);
    expect(ok.committed).toBe(true);
    const next: SourceRef = { ...ref, generation: 2 };
    built.sink.adopt(next);
    const stale = await commitNow(
      built,
      messages(ref, 3, "stale"),
      "c2",
      oldToken,
    );
    expect(stale.committed).toBe(false);
    expect(stale.refusal?.code).toBe("stale_generation");
    expect(await built.sink.cursor(ref)).toBe("c1");
    expect(count(built.dir, "content")).toBe(2);
    await expectIntegrity(built);
  }, 90_000);

  it("lets a commit that is already in flight finish before a later upsert or remove takes effect", async () => {
    const built = rig();
    const ref = source("inflight", 1, BASE_MS);
    const token = built.sink.adopt(ref);
    await commitNow(built, messages(ref, 1, "seed"), "c0", token);
    arm(built, "arm-hold");
    const expected = await built.sink.cursor(ref);
    const inflight = built.sink.commit(
      messages(ref, 2, "flight"),
      { expected, next: "c1" },
      () => true,
      token,
    );
    await until(() => existsSync(join(built.control, "held")));
    const next: SourceRef = { ...ref, generation: 2 };
    built.sink.adopt(next);
    const removal = built.sink.removeSource(ref.key);
    writeFileSync(join(built.control, "release"), "");
    const result = await inflight;
    expect(result.committed).toBe(true);
    expect(await removal).toBeGreaterThanOrEqual(0);
    expect(count(built.dir, "content")).toBe(0);
    const late = await commitNow(built, messages(ref, 1, "late"), "c2", token);
    expect(late.committed).toBe(false);
    expect(late.refusal?.code).toBe("stale_generation");
    expect(count(built.dir, "content")).toBe(0);
    await expectIntegrity(built);
  }, 90_000);
});

describe("writer kill barriers on a real WAL database", () => {
  it("rolls back content, index and cursor together when killed after the writes and before COMMIT, then replays", async () => {
    const built = rig();
    const ref = source("barrier-a", 1, BASE_MS);
    const token = built.sink.adopt(ref);
    await commitNow(built, messages(ref, 1, "base"), "c0", token);
    const firstPid = built.sink.client.pid;
    arm(built, "arm-kill-before-commit");
    const refused = await commitNow(
      built,
      messages(ref, 4, "doomed"),
      "c1",
      token,
    );
    expect(refused.committed).toBe(false);
    expect(refused.refusal?.code).toBe("cursor_conflict");
    const record = built.sink.reconciliations().at(-1);
    expect(record?.outcome).toBe("rolled_back");
    expect(record?.cause).toBe("crash");
    expect(count(built.dir, "content")).toBe(1);
    expect(ftsHits(built.dir, "doomed")).toBe(0);
    expect(await built.sink.cursor(ref)).toBe("c0");
    const replay = await commitNow(
      built,
      messages(ref, 4, "doomed"),
      "c1",
      token,
    );
    expect(replay.committed).toBe(true);
    expect(replay.inserted).toBe(4);
    expect(count(built.dir, "content")).toBe(5);
    expect(ftsHits(built.dir, "doomed")).toBe(4);
    expect(built.sink.client.pid).not.toBe(firstPid);
    expect(pids(built).length).toBe(2);
    await expectIntegrity(built);
  }, 90_000);

  it("detects a commit that was durable before the ack was lost and applies it exactly once", async () => {
    const built = rig();
    const ref = source("barrier-b", 1, BASE_MS);
    const token = built.sink.adopt(ref);
    await commitNow(built, messages(ref, 1, "base"), "c0", token);
    arm(built, "arm-kill-before-ack");
    const batch = messages(ref, 4, "acked");
    const refused = await commitNow(built, batch, "c1", token);
    expect(refused.committed).toBe(false);
    expect(refused.refusal?.code).toBe("cursor_conflict");
    const record = built.sink.reconciliations().at(-1);
    expect(record?.outcome).toBe("committed");
    expect(count(built.dir, "content")).toBe(5);
    expect(ftsHits(built.dir, "acked")).toBe(4);
    expect(await built.sink.cursor(ref)).toBe("c1");
    const replay = await commitNow(built, batch, "c2", token);
    expect(replay.committed).toBe(true);
    expect(replay.inserted).toBe(0);
    expect(count(built.dir, "content")).toBe(5);
    expect(ftsHits(built.dir, "acked")).toBe(4);
    await expectIntegrity(built);
  }, 90_000);
});

describe("writer memory pressure", () => {
  it.skipIf(!supported)(
    "keeps the writer's base RSS under the child limits",
    async () => {
      const built = rig();
      const ref = source("rss", 1, BASE_MS);
      const token = built.sink.adopt(ref);
      await commitNow(built, messages(ref, 8), "c1", token);
      const pid = built.sink.client.pid;
      expect(pid).not.toBeNull();
      const memory = readProcessMemory(pid!);
      expect(memory).not.toBeNull();
      expect(memory!.rssBytes).toBeLessThan(
        built.supervisor.limits.childSuspendBytes,
      );
    },
    90_000,
  );

  it.skipIf(!supported)(
    "attributes a writer memory kill to the store, persists it across a writer restart and spends one controlled retry",
    async () => {
      const built = rig();
      const a = source("src-a", 1, BASE_MS);
      const b = source("src-b", 1, BASE_MS);
      const tokenA = built.sink.adopt(a);
      const tokenB = built.sink.adopt(b);
      arm(built, "arm-bloat");
      const killed = await commitNow(
        built,
        messages(a, 2, "alpha"),
        "a1",
        tokenA,
      );
      expect(killed.committed).toBe(false);
      expect(killed.refusal?.code).toBe("memory_pressure");
      expect(killed.mergePossible).toBe(true);
      expect(built.supervisor.kills().length).toBe(1);
      const record = built.sink.reconciliations().at(-1);
      expect(record?.cause).toBe("memory_kill");
      expect(record?.outcome).toBe("rolled_back");
      expect(record?.pressureRecorded).toBe(true);
      expect(count(built.dir, "content")).toBe(0);

      const suspended = await built.sink.state();
      expect(suspended.pressure.status).toBe("suspended");
      expect(suspended.suspended?.code).toBe("memory_pressure");
      const incarnations = built.sink.client.incarnations;
      const refusedB = await commitNow(
        built,
        messages(b, 2, "bravo"),
        "b1",
        tokenB,
      );
      expect(refusedB.refusal?.code).toBe("memory_pressure");
      expect(built.sink.client.incarnations).toBe(incarnations);
      expect(count(built.dir, "content")).toBe(0);

      const pid = built.sink.client.pid;
      process.kill(pid!, "SIGKILL");
      await until(() => {
        try {
          process.kill(pid!, 0);
          return false;
        } catch {
          return true;
        }
      });
      const persisted = await stateEventually(built);
      expect(persisted.pressure.status).toBe("suspended");
      expect(built.sink.client.incarnations).toBeGreaterThan(incarnations);

      const retry = await built.sink.beginControlledRetry("raised headroom");
      expect(retry.ok).toBe(true);
      arm(built, "arm-bloat");
      const second = await commitNow(
        built,
        messages(b, 2, "bravo"),
        "b1",
        tokenB,
      );
      expect(second.committed).toBe(false);
      expect(second.refusal?.code).toBe("memory_pressure");
      expect(built.supervisor.kills().length).toBe(2);
      expect(count(built.dir, "content")).toBe(0);

      const spent = await built.sink.beginControlledRetry("again");
      expect(spent.ok).toBe(false);
      const final = await stateEventually(built);
      expect(final.pressure.status).toBe("suspended");
      expect(final.pressure.retriesUsed).toBe(1);
      const settled = built.sink.client.incarnations;
      await pause(500);
      expect(built.sink.client.incarnations).toBe(settled);
      await expectIntegrity(built);
    },
    180_000,
  );
});

const MEMORY_TESTS_MS = 180_000;

describe("writer memory kills in every request state", () => {
  it.skipIf(!supported)(
    "refuses commits already queued behind a memory-killed commit instead of restarting a clear writer",
    async () => {
      const built = rig();
      const refs = ["q-a", "q-b", "q-c"].map((key) => source(key, 1, BASE_MS));
      const tokens = refs.map((ref) => built.sink.adopt(ref));
      const expected = await Promise.all(
        refs.map((ref) => built.sink.cursor(ref)),
      );
      arm(built, "arm-bloat");
      const results = await Promise.all(
        refs.map((ref, index) =>
          built.sink.commit(
            messages(ref, 2, `queued${index}`),
            { expected: expected[index] ?? null, next: `c${index}` },
            () => true,
            tokens[index],
          ),
        ),
      );
      expect(results.map((result) => result.committed)).toEqual([
        false,
        false,
        false,
      ]);
      for (const result of results) {
        expect(["memory_pressure", "suspended"]).toContain(
          result.refusal?.code,
        );
      }
      expect(count(built.dir, "content")).toBe(0);
      expect(built.supervisor.kills().length).toBe(1);
      expect(built.sink.reconciliations()[0]?.pressureRecorded).toBe(true);
      const state = await built.sink.state();
      expect(state.pressure.status).toBe("suspended");
      await expectIntegrity(built);
    },
    MEMORY_TESTS_MS,
  );

  it.skipIf(!supported)(
    "keeps the suspension when the supervisor kills an idle writer",
    async () => {
      const built = rig();
      const ref = source("idle-a", 1, BASE_MS);
      const token = built.sink.adopt(ref);
      const first = await commitNow(built, messages(ref, 2), "c1", token);
      expect(first.committed).toBe(true);
      const incarnations = built.sink.client.incarnations;
      arm(built, "arm-bloat-idle");
      await until(() => built.supervisor.kills().length === 1);
      const state = await stateEventually(built);
      expect(built.sink.client.incarnations).toBeGreaterThan(incarnations);
      expect(state.pressure.status).toBe("suspended");
      expect(state.suspended?.code).toBe("memory_pressure");
      const other = source("idle-b", 1, BASE_MS);
      const refused = await commitNow(
        built,
        messages(other, 2, "late"),
        "c1",
        built.sink.adopt(other),
      );
      expect(refused.committed).toBe(false);
      expect(refused.refusal?.code).toBe("memory_pressure");
      expect(count(built.dir, "content")).toBe(2);
      await expectIntegrity(built);
    },
    MEMORY_TESTS_MS,
  );

  it.skipIf(!supported)(
    "keeps the suspension when the supervisor kills a writer serving a cursor request",
    async () => {
      const built = rig();
      const ref = source("cursor-a", 1, BASE_MS);
      built.sink.adopt(ref);
      arm(built, "arm-bloat-cursor");
      expect(await built.sink.cursor(ref)).toBeNull();
      expect(built.supervisor.kills().length).toBe(1);
      const state = await stateEventually(built);
      expect(state.pressure.status).toBe("suspended");
      expect(state.suspended?.code).toBe("memory_pressure");
      const other = source("cursor-b", 1, BASE_MS);
      const refused = await commitNow(
        built,
        messages(other, 2),
        "c1",
        built.sink.adopt(other),
      );
      expect(refused.refusal?.code).toBe("memory_pressure");
      expect(count(built.dir, "content")).toBe(0);
      await expectIntegrity(built);
    },
    MEMORY_TESTS_MS,
  );
});

interface SchedulerRig {
  built: Rig;
  scheduler: ParserScheduler;
  files: string;
}

function schedulerRig(options: { cursorWaitMs?: number } = {}): SchedulerRig {
  const built = rig(options);
  const files = mkdtempSync(join(tmpdir(), "ss-writer-files-"));
  temps.push(files);
  const slot = new ParserSlot({
    label: "parser-0",
    supervisor: built.supervisor,
    args: PARSER_ARGS,
    cwd: packageDir,
    admissionWaitMs: 2_000,
    idleExitMs: 0,
  });
  slots.push(slot);
  const scheduler = new ParserScheduler({
    parsers: [slot],
    sink: built.sink,
    clock: () => Date.now(),
    stallMs: 120_000,
    unreadableBackoffMs: 50,
    unreadableBackoffMaxMs: 200,
    deferBackoffMs: 50,
    restartBackoffMs: 50,
    restartBackoffMaxMs: 200,
  });
  return { built, scheduler, files };
}

function sessionFile(
  files: string,
  name: string,
  messageCount = 3,
): ParserSourceSpec {
  const path = join(files, name);
  mkdirSync(dirname(path), { recursive: true });
  const lines = Array.from({ length: messageCount }, (_, index) =>
    JSON.stringify({
      type: "user",
      uuid: `${name}-${index}`,
      sessionId: "s1",
      timestamp: "2026-01-01T00:00:00.000Z",
      cwd: "/work/fixture",
      message: { role: "user", content: `${name} message ${index}` },
    }),
  );
  writeFileSync(path, lines.join("\n") + "\n");
  return {
    ref: { key: name, generation: 1, discoveredAtMs: 1 },
    provider: "claude",
    path,
  };
}

async function pump(
  rigged: SchedulerRig,
  condition: () => boolean,
  limitMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + limitMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("scheduler did not settle");
    await rigged.scheduler.drain();
    await pause(30);
  }
}

describe("writer behind the parser scheduler", () => {
  it("indexes two sources through the writer child and never lets a parser bypass it", async () => {
    const rigged = schedulerRig();
    rigged.scheduler.upsert(sessionFile(rigged.files, "a.jsonl"));
    rigged.scheduler.upsert(sessionFile(rigged.files, "b.jsonl"));
    await pump(
      rigged,
      () =>
        rigged.scheduler.state("a.jsonl")?.status === "idle" &&
        rigged.scheduler.state("b.jsonl")?.status === "idle",
    );
    expect(count(rigged.built.dir, "content")).toBe(6);
    expect(pids(rigged.built).length).toBe(1);
    await rigged.scheduler.drain();
    await expectIntegrity(rigged.built);
  }, 120_000);

  it("defers every source through a prolonged writer outage without spending its quarantine budget", async () => {
    const rigged = schedulerRig({ cursorWaitMs: 100 });
    arm(rigged.built, "outage");
    rigged.scheduler.upsert(sessionFile(rigged.files, "a.jsonl"));
    rigged.scheduler.upsert(sessionFile(rigged.files, "b.jsonl"));
    const keys = ["a.jsonl", "b.jsonl"];
    const draining = rigged.scheduler.drain();
    await until(
      () =>
        keys.every((key) => {
          const view = rigged.scheduler.state(key);
          return (
            view === null || view.status === "quarantined" || view.turns >= 8
          );
        }),
      60_000,
    );
    for (const key of keys) {
      const view = rigged.scheduler.state(key);
      expect(view).not.toBeNull();
      expect(view?.status).not.toBe("quarantined");
      expect(view?.reason).toContain("writer unavailable");
    }
    rmSync(join(rigged.built.control, "outage"));
    await until(
      () => keys.every((key) => rigged.scheduler.state(key)?.status === "idle"),
      60_000,
    );
    await draining;
    expect(count(rigged.built.dir, "content")).toBe(6);
    await rigged.scheduler.drain();
    await expectIntegrity(rigged.built);
  }, 120_000);

  it.skipIf(!supported)(
    "suspends both sources visibly after a writer memory kill without quarantining either, then resumes after the controlled retry",
    async () => {
      const rigged = schedulerRig();
      arm(rigged.built, "arm-bloat");
      rigged.scheduler.upsert(sessionFile(rigged.files, "a.jsonl"));
      rigged.scheduler.upsert(sessionFile(rigged.files, "b.jsonl"));
      await pump(
        rigged,
        () =>
          rigged.built.supervisor.kills().length >= 1 &&
          rigged.built.sink
            .reconciliations()
            .some((record) => record.pressureRecorded) &&
          rigged.scheduler.state("a.jsonl")?.status === "deferred" &&
          rigged.scheduler.state("b.jsonl")?.status === "deferred",
      );
      for (const key of ["a.jsonl", "b.jsonl"]) {
        expect(rigged.scheduler.state(key)?.status).not.toBe("quarantined");
        expect(rigged.scheduler.state(key)?.reason).toContain(
          "memory_pressure",
        );
      }
      expect(count(rigged.built.dir, "content")).toBe(0);
      const state = await rigged.built.sink.state();
      expect(state.pressure.status).toBe("suspended");

      const retry =
        await rigged.built.sink.beginControlledRetry("raised headroom");
      expect(retry.ok).toBe(true);
      await pump(
        rigged,
        () =>
          rigged.scheduler.state("a.jsonl")?.status === "idle" &&
          rigged.scheduler.state("b.jsonl")?.status === "idle",
      );
      expect(count(rigged.built.dir, "content")).toBe(6);
      const cleared = await rigged.built.sink.state();
      expect(cleared.pressure.status).toBe("clear");
      await rigged.scheduler.drain();
      await expectIntegrity(rigged.built);
    },
    240_000,
  );
});
