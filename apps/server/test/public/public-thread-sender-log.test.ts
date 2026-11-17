import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createQueuedThreadMessage } from "@bb/db";
import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { handleDaemonSocketClosed } from "../../src/internal/session-owner-side-effects.js";
import { markTunnelIngressRequest } from "../../src/request-context.js";
import {
  SENDER_LOG_DIR_NAME,
  SENDER_LOG_RETENTION_DAYS,
  senderLogFileName,
  createSenderLogSink,
  logThreadSender,
  readSenderRecord,
  type SenderLogEntry,
} from "../../src/services/threads/sender-record.js";
import { readJson } from "../helpers/json.js";
import { textInput } from "../helpers/prompt-input.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
  seedThreadRuntimeState,
} from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

const noPluginCaller = () => ({ ok: false as const });

function quietLogger(warn: () => void = () => {}) {
  return { debug() {}, info() {}, error() {}, warn };
}

function sampleEntry(index: number): SenderLogEntry {
  return {
    route: "send",
    requestedThreadId: `thr_${index}`,
    threadId: `thr_${index}`,
    messageSequence: index,
    queuedMessageId: null,
    sender: {
      kind: "api",
      verified: false,
      operatorSession: false,
      claimedSenderThreadId: null,
      callerThreadHeader: null,
      pluginId: null,
      surface: "api",
      gateAuth: null,
      accessRoute: null,
      machineId: null,
    },
    textSha256: "0".repeat(64),
    textLength: 0,
    inputChunkCount: 1,
  };
}

function scratchDir(): string {
  return mkdtempSync(join(tmpdir(), "sender-log-test-"));
}

function readLog(harness: TestAppHarness): Record<string, unknown>[] {
  const file = join(
    harness.config.dataDir,
    "sender-log",
    senderLogFileName(Date.now()),
  );
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function seedOfflineThread(harness: TestAppHarness) {
  const { host, session } = seedHostSession(harness.deps, {
    id: "host-sender-log",
    name: "M5",
  });
  const { project } = seedProjectWithSource(harness.deps, {
    hostId: host.id,
  });
  const environment = seedEnvironment(harness.deps, {
    hostId: host.id,
    projectId: project.id,
    path: "/tmp/sender-log",
  });
  const thread = seedThread(harness.deps, {
    projectId: project.id,
    environmentId: environment.id,
    status: "idle",
  });
  seedThreadRuntimeState(harness.deps, {
    threadId: thread.id,
    environmentId: environment.id,
    providerThreadId: "provider-sender-log",
  });
  handleDaemonSocketClosed(harness.deps, { sessionId: session.id });
  harness.hub.cancelPendingDaemonDisconnect(session.id);
  return thread;
}

function sendBody(text: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    input: [{ type: "text", text, mentions: [] }],
    mode: "steer-if-active",
    model: "gpt-5",
    permissionMode: "full",
    reasoningLevel: "medium",
    serviceTier: "default",
    ...extra,
  });
}

async function classify(
  headers: Record<string, string>,
  options: {
    tunnel?: boolean;
    claimed?: string;
    resolvePluginCaller?: Parameters<
      typeof readSenderRecord
    >[1]["resolvePluginCaller"];
  } = {},
) {
  const app = new Hono();
  app.all("*", (context) =>
    context.json(
      readSenderRecord(context, {
        claimedSenderThreadId: options.claimed,
        resolvePluginCaller: options.resolvePluginCaller ?? noPluginCaller,
      }),
    ),
  );
  const incoming = { socket: { remoteAddress: "127.0.0.1" } };
  if (options.tunnel) markTunnelIngressRequest(incoming);
  const response = await app.fetch(
    new Request("http://example.test/api/v1/threads/t/send", { headers }),
    { incoming },
  );
  return response.json() as Promise<Record<string, unknown>>;
}

describe("sender record classification", () => {
  it("treats a tunnelled session as a verified operator session", async () => {
    expect(
      await classify(
        { "x-bb-gate-auth": "session", "x-bb-app-surface": "web" },
        { tunnel: true },
      ),
    ).toMatchObject({
      kind: "app",
      verified: true,
      operatorSession: true,
      accessRoute: "connect",
      gateAuth: "session",
      surface: "web",
    });
  });

  it("does not trust a client-set session header on a local request", async () => {
    expect(
      await classify({
        "x-bb-gate-auth": "session",
        "x-bb-app-surface": "web",
      }),
    ).toMatchObject({
      kind: "app",
      verified: false,
      operatorSession: false,
      accessRoute: "loopback",
    });
  });

  it("keeps a claimed thread asserted, never verified", async () => {
    expect(
      await classify(
        { "x-bb-cli": "1", "x-bb-caller-thread": "thr_claimed" },
        { claimed: "thr_claimed" },
      ),
    ).toMatchObject({
      kind: "cli",
      verified: false,
      claimedSenderThreadId: "thr_claimed",
      callerThreadHeader: "thr_claimed",
    });
  });

  it("does not let a machine gate header raise trust", async () => {
    expect(
      await classify(
        { "x-bb-gate-auth": "machine", "x-bb-gate-machine-id": "m1" },
        { tunnel: true },
      ),
    ).toMatchObject({
      kind: "api",
      verified: false,
      operatorSession: false,
      accessRoute: null,
      machineId: "m1",
    });
  });

  it("records a plain request as unverified api", async () => {
    expect(await classify({})).toMatchObject({
      kind: "api",
      verified: false,
      claimedSenderThreadId: null,
      callerThreadHeader: null,
      pluginId: null,
    });
  });

  it("verifies only a plugin caller the registry resolved", async () => {
    expect(
      await classify(
        { "x-bb-plugin-caller": "token" },
        {
          resolvePluginCaller: () => ({
            ok: true as const,
            caller: { kind: "plugin" as const, pluginId: "plugin-a" },
          }),
        },
      ),
    ).toMatchObject({ kind: "plugin", verified: true, pluginId: "plugin-a" });
    expect(await classify({ "x-bb-plugin-caller": "forged" })).toMatchObject({
      kind: "api",
      verified: false,
      pluginId: null,
    });
    expect(
      await classify(
        { "x-bb-plugin-caller": "token", "x-bb-cli": "1" },
        {
          resolvePluginCaller: () => ({
            ok: true as const,
            caller: { kind: "client" as const },
          }),
        },
      ),
    ).toMatchObject({ kind: "cli", verified: false, pluginId: null });
  });

  it("bounds asserted identifiers instead of storing them verbatim", async () => {
    const long = "x".repeat(5000);
    const record = await classify(
      {
        "x-bb-cli": "1",
        "x-bb-caller-thread": "not an id",
        "x-bb-gate-auth": "machine",
        "x-bb-gate-machine-id": long,
      },
      { claimed: long },
    );
    expect(record.callerThreadHeader).toMatch(/^invalid:[0-9a-f]{16}:9$/);
    expect(record.machineId).toMatch(/^invalid:[0-9a-f]{16}:5000$/);
    expect(record.claimedSenderThreadId).toMatch(/^invalid:[0-9a-f]{16}:5000$/);
    expect(JSON.stringify(record)).not.toContain("not an id");
    expect(JSON.stringify(record)).not.toContain("xxxxxxxx");
  });
});

describe("sender log sink", () => {
  it("writes serialized valid lines for concurrent records", async () => {
    const dir = scratchDir();
    try {
      const sink = createSenderLogSink({ dataDir: dir, logger: quietLogger() });
      for (let index = 0; index < 200; index += 1) {
        sink.record(sampleEntry(index));
        if (index % 50 === 0) await Promise.resolve();
      }
      await sink.flush();
      const lines = readFileSync(
        join(dir, "sender-log", senderLogFileName(Date.now())),
        "utf8",
      )
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as { messageSequence: number });
      expect(lines.map((line) => line.messageSequence)).toEqual(
        Array.from({ length: 200 }, (_, index) => index),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("tightens a permissive existing directory and file", async () => {
    const dir = scratchDir();
    try {
      const logDir = join(dir, "sender-log");
      mkdirSync(logDir, { mode: 0o755 });
      chmodSync(logDir, 0o755);
      const file = join(logDir, senderLogFileName(Date.now()));
      writeFileSync(file, "");
      chmodSync(file, 0o644);
      const sink = createSenderLogSink({ dataDir: dir, logger: quietLogger() });
      sink.record(sampleEntry(1));
      await sink.flush();
      expect(statSync(logDir).mode & 0o777).toBe(0o700);
      expect(statSync(file).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a symlinked log file and leaves its target untouched", async () => {
    const dir = scratchDir();
    try {
      const logDir = join(dir, "sender-log");
      mkdirSync(logDir, { mode: 0o700 });
      const target = join(dir, "elsewhere.txt");
      writeFileSync(target, "keep");
      symlinkSync(target, join(logDir, senderLogFileName(Date.now())));
      const warn = vi.fn();
      const sink = createSenderLogSink({
        dataDir: dir,
        logger: quietLogger(warn),
      });
      sink.record(sampleEntry(1));
      await sink.flush();
      expect(readFileSync(target, "utf8")).toBe("keep");
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a symlinked log directory", async () => {
    const dir = scratchDir();
    try {
      const elsewhere = join(dir, "elsewhere");
      mkdirSync(elsewhere);
      symlinkSync(elsewhere, join(dir, "sender-log"));
      const warn = vi.fn();
      const sink = createSenderLogSink({
        dataDir: dir,
        logger: quietLogger(warn),
      });
      sink.record(sampleEntry(1));
      await sink.flush();
      expect(existsSync(join(elsewhere, senderLogFileName(Date.now())))).toBe(
        false,
      );
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not block on a named pipe at the log path", async () => {
    const dir = scratchDir();
    try {
      const logDir = join(dir, "sender-log");
      mkdirSync(logDir, { mode: 0o700 });
      execFileSync("mkfifo", [join(logDir, senderLogFileName(Date.now()))]);
      const warn = vi.fn();
      const sink = createSenderLogSink({
        dataDir: dir,
        logger: quietLogger(warn),
      });
      sink.record(sampleEntry(1));
      await sink.flush();
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("drops records beyond the backlog bound and warns", async () => {
    const dir = scratchDir();
    try {
      const warn = vi.fn();
      const sink = createSenderLogSink({
        dataDir: dir,
        logger: quietLogger(warn),
        maxPending: 3,
      });
      for (let index = 0; index < 6; index += 1)
        sink.record(sampleEntry(index));
      await sink.flush();
      const lines = readFileSync(
        join(dir, "sender-log", senderLogFileName(Date.now())),
        "utf8",
      )
        .split("\n")
        .filter((line) => line.length > 0);
      expect(lines).toHaveLength(4);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  describe("retention", () => {
    const DAY_MS = 24 * 60 * 60 * 1000;
    const noon = Date.UTC(2026, 10, 17, 12, 0, 0);

    function seedLogDir(dir: string): string {
      const logDir = join(dir, SENDER_LOG_DIR_NAME);
      mkdirSync(logDir, { recursive: true, mode: 0o700 });
      return logDir;
    }

    function seedDayFile(logDir: string, daysAgo: number): string {
      const path = join(logDir, senderLogFileName(noon - daysAgo * DAY_MS));
      writeFileSync(path, '{"seeded":true}\n');
      return path;
    }

    it("states a 30 day retention", () => {
      expect(SENDER_LOG_RETENTION_DAYS).toBe(30);
    });

    it("deletes day files that are 30 or more days old at startup and keeps newer ones", async () => {
      const dir = scratchDir();
      try {
        const logDir = seedLogDir(dir);
        const old45 = seedDayFile(logDir, 45);
        const old31 = seedDayFile(logDir, 31);
        const old30 = seedDayFile(logDir, 30);
        const keep29 = seedDayFile(logDir, 29);
        const keep1 = seedDayFile(logDir, 1);
        const keepToday = seedDayFile(logDir, 0);
        const unrelated = join(logDir, "notes.txt");
        writeFileSync(unrelated, "keep");
        const badDate = join(logDir, "sender-log-2026-13-45.jsonl");
        writeFileSync(badDate, "keep");
        const sink = createSenderLogSink({
          dataDir: dir,
          logger: quietLogger(),
          now: () => noon,
          pruneIntervalMs: 0,
        });
        await sink.flush();
        for (const gone of [old45, old31, old30])
          expect(existsSync(gone)).toBe(false);
        for (const kept of [keep29, keep1, keepToday, unrelated, badDate])
          expect(existsSync(kept)).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("never follows or removes a symlink that carries an expired name", async () => {
      const dir = scratchDir();
      try {
        const logDir = seedLogDir(dir);
        const victim = join(dir, "victim.txt");
        writeFileSync(victim, "keep");
        const link = join(logDir, senderLogFileName(noon - 60 * DAY_MS));
        symlinkSync(victim, link);
        const sink = createSenderLogSink({
          dataDir: dir,
          logger: quietLogger(),
          now: () => noon,
          pruneIntervalMs: 0,
        });
        await sink.flush();
        expect(readFileSync(victim, "utf8")).toBe("keep");
        expect(lstatSync(link).isSymbolicLink()).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("rolls to a new day file and prunes the expired one when the day changes", async () => {
      const dir = scratchDir();
      try {
        let clock = noon;
        const sink = createSenderLogSink({
          dataDir: dir,
          logger: quietLogger(),
          now: () => clock,
          pruneIntervalMs: 0,
        });
        sink.record(sampleEntry(1));
        await sink.flush();
        const first = join(dir, SENDER_LOG_DIR_NAME, senderLogFileName(clock));
        expect(existsSync(first)).toBe(true);
        clock = noon + 29 * DAY_MS;
        sink.record(sampleEntry(2));
        await sink.flush();
        expect(existsSync(first)).toBe(true);
        clock = noon + 30 * DAY_MS;
        sink.record(sampleEntry(3));
        await sink.flush();
        expect(existsSync(first)).toBe(false);
        const today = join(dir, SENDER_LOG_DIR_NAME, senderLogFileName(clock));
        expect(
          readFileSync(today, "utf8").split("\n").filter(Boolean),
        ).toHaveLength(1);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("writes each record to the file for the day it was recorded", async () => {
      const dir = scratchDir();
      try {
        let clock = Date.UTC(2026, 10, 17, 23, 59, 59);
        const sink = createSenderLogSink({
          dataDir: dir,
          logger: quietLogger(),
          now: () => clock,
          pruneIntervalMs: 0,
        });
        sink.record(sampleEntry(1));
        clock += 2000;
        sink.record(sampleEntry(2));
        await sink.flush();
        const logDir = join(dir, SENDER_LOG_DIR_NAME);
        expect(readdirSync(logDir).sort()).toEqual([
          "sender-log-2026-11-17.jsonl",
          "sender-log-2026-11-18.jsonl",
        ]);
        for (const name of readdirSync(logDir))
          expect(
            readFileSync(join(logDir, name), "utf8")
              .split("\n")
              .filter(Boolean),
          ).toHaveLength(1);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("prunes on a timer without any write", async () => {
      const dir = scratchDir();
      try {
        const logDir = seedLogDir(dir);
        let clock = noon;
        const sink = createSenderLogSink({
          dataDir: dir,
          logger: quietLogger(),
          now: () => clock,
          pruneIntervalMs: 20,
        });
        await sink.flush();
        const aging = seedDayFile(logDir, 0);
        clock = noon + 31 * DAY_MS;
        await vi.waitFor(() => expect(existsSync(aging)).toBe(false));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  it("never throws out of logThreadSender when the context read or the sink fails", async () => {
    const warn = vi.fn(() => {
      throw new Error("warn failed");
    });
    const logger = quietLogger(warn);
    const brokenContext = {
      req: {
        header() {
          throw new Error("header read failed");
        },
        path: "/api/v1/threads/t/send",
      },
      env: {},
    } as unknown as Parameters<typeof logThreadSender>[2];
    const recorded: SenderLogEntry[] = [];
    const recordingSink = {
      record(entry: SenderLogEntry) {
        recorded.push(entry);
      },
      async flush() {},
    };
    const failingSink = {
      record: vi.fn(() => {
        throw new Error("sink failed");
      }),
      async flush() {},
    };
    const args = {
      route: "send" as const,
      requestedThreadId: "t",
      threadId: "t",
      messageSequence: null,
      queuedMessageId: null,
      claimedSenderThreadId: undefined,
      input: [],
      resolvePluginCaller: noPluginCaller,
    };
    expect(() =>
      logThreadSender(recordingSink, logger, brokenContext, args),
    ).not.toThrow();
    expect(recorded).toHaveLength(0);
    expect(warn).toHaveBeenCalledTimes(1);
    const app = new Hono();
    app.all("*", (context) => {
      expect(() =>
        logThreadSender(failingSink, logger, context, args),
      ).not.toThrow();
      logThreadSender(recordingSink, logger, context, args);
      return context.json({ ok: true });
    });
    const response = await app.fetch(
      new Request("http://example.test/api/v1/threads/t/send"),
      { incoming: { socket: { remoteAddress: "127.0.0.1" } } },
    );
    expect(response.status).toBe(200);
    expect(failingSink.record).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.threadId).toBe("t");
  });

  it("writes a record that arrives while the drain is finishing, without a flush", async () => {
    const dir = scratchDir();
    try {
      const sink = createSenderLogSink({ dataDir: dir, logger: quietLogger() });
      sink.record(sampleEntry(1));
      await new Promise<void>((resolve) => setImmediate(resolve));
      sink.record(sampleEntry(2));
      sink.record(sampleEntry(3));
      const file = join(dir, "sender-log", senderLogFileName(Date.now()));
      const deadline = Date.now() + 5000;
      let lines: string[] = [];
      while (Date.now() < deadline) {
        lines = existsSync(file)
          ? readFileSync(file, "utf8").split("\n").filter(Boolean)
          : [];
        if (lines.length === 3) break;
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
      expect(lines).toHaveLength(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("survives a throwing warn when an append fails", async () => {
    const dir = scratchDir();
    try {
      mkdirSync(join(dir, "sender-log", senderLogFileName(Date.now())), {
        recursive: true,
      });
      const warn = vi.fn(() => {
        throw new Error("warn failed");
      });
      const sink = createSenderLogSink({
        dataDir: dir,
        logger: quietLogger(warn),
      });
      sink.record(sampleEntry(1));
      await expect(sink.flush()).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("sender log on thread messages", () => {
  it("logs a direct send tied to its response, with a hash and not the text", async () => {
    await withTestHarness(async (harness) => {
      const thread = seedOfflineThread(harness);
      const text = "steer text that must not be logged";
      const response = await harness.app.request(
        `/api/v1/threads/${thread.id}/send`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-bb-cli": "1",
            "x-bb-caller-thread": "thr_asserted",
          },
          body: sendBody(text),
        },
      );
      expect(response.status).toBe(200);
      const body = (await readJson(response)) as {
        ok: boolean;
        delivery: string;
        queuedMessage?: { id: string };
      };
      expect(body).toMatchObject({ ok: true, delivery: "queued" });
      await vi.waitFor(() => expect(readLog(harness)).toHaveLength(1));
      const lines = readLog(harness);
      expect(lines[0]).toMatchObject({
        route: "send",
        requestedThreadId: thread.id,
        threadId: thread.id,
        queuedMessageId: body.queuedMessage?.id,
        textSha256: createHash("sha256").update(text).digest("hex"),
        textLength: text.length,
        inputChunkCount: 1,
        sender: {
          kind: "cli",
          verified: false,
          callerThreadHeader: "thr_asserted",
        },
      });
      const raw = readFileSync(
        join(
          harness.config.dataDir,
          "sender-log",
          senderLogFileName(Date.now()),
        ),
        "utf8",
      );
      expect(raw).not.toContain(text);
    });
  });

  it("logs a queued message with its id, a hash and no text", async () => {
    await withTestHarness(async (harness) => {
      const thread = seedOfflineThread(harness);
      const text = "queued text that must not be logged";
      const response = await harness.app.request(
        `/api/v1/threads/${thread.id}/queued-messages`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            input: [{ type: "text", text, mentions: [] }],
          }),
        },
      );
      expect(response.status).toBe(201);
      const queued = (await readJson(response)) as { id: string };
      await vi.waitFor(() => expect(readLog(harness)).toHaveLength(1));
      const lines = readLog(harness);
      expect(lines[0]).toMatchObject({
        route: "queue",
        requestedThreadId: thread.id,
        threadId: thread.id,
        queuedMessageId: queued.id,
        messageSequence: null,
        textSha256: createHash("sha256").update(text).digest("hex"),
        sender: { kind: "api", verified: false, claimedSenderThreadId: null },
      });
      const raw = readFileSync(
        join(
          harness.config.dataDir,
          "sender-log",
          senderLogFileName(Date.now()),
        ),
        "utf8",
      );
      expect(raw).not.toContain(text);
    });
  });

  it("records the successor as the destination of a redirected post", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, { id: "host-redirect" });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/sender-log-redirect",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/sender-log-redirect",
        status: "ready",
      });
      const source = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "active",
      });
      const target = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "active",
      });
      createQueuedThreadMessage(harness.db, harness.hub, {
        threadId: source.id,
        content: textInput("seed"),
        model: "gpt-5",
        reasoningLevel: "medium",
        permissionMode: "full",
        serviceTier: "default",
        waitingOn: { kind: "thread-busy" },
        sendAt: null,
        payload: { kind: "inline" },
        systemNotice: null,
      });
      const retire = await harness.app.request(
        `/api/v1/threads/${source.id}/retire`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            targetThreadId: target.id,
            operationKey: "sender-log-k1",
          }),
        },
      );
      expect(retire.status).toBeLessThan(300);
      const response = await harness.app.request(
        `/api/v1/threads/${source.id}/queued-messages`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            input: textInput("late"),
            model: "gpt-5",
            reasoningLevel: "medium",
            permissionMode: "full",
            serviceTier: "default",
          }),
        },
      );
      expect(response.status).toBe(201);
      const queued = (await readJson(response)) as {
        id: string;
        threadId?: string;
      };
      await vi.waitFor(() => expect(readLog(harness)).toHaveLength(1));
      expect(readLog(harness)[0]).toMatchObject({
        route: "queue",
        requestedThreadId: source.id,
        threadId: target.id,
        queuedMessageId: queued.id,
      });
    });
  }, 20_000);

  it("logs nothing for a rejected request", async () => {
    await withTestHarness(async (harness) => {
      const thread = seedOfflineThread(harness);
      const rejected = await harness.app.request(
        `/api/v1/threads/${thread.id}/send`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ input: "not a prompt" }),
        },
      );
      expect(rejected.status).toBeGreaterThanOrEqual(400);
      const accepted = await harness.app.request(
        `/api/v1/threads/${thread.id}/send`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: sendBody("accepted"),
        },
      );
      expect(accepted.status).toBe(200);
      await vi.waitFor(() => expect(readLog(harness)).toHaveLength(1));
      expect(readLog(harness)[0]).toMatchObject({
        textLength: "accepted".length,
      });
    });
  });

  it("still accepts and persists the message when the log cannot be written", async () => {
    await withTestHarness(async (harness) => {
      const thread = seedOfflineThread(harness);
      const dir = join(harness.config.dataDir, "sender-log");
      mkdirSync(dir, { recursive: true });
      const target = join(harness.config.dataDir, "elsewhere.txt");
      writeFileSync(target, "keep");
      symlinkSync(target, join(dir, senderLogFileName(Date.now())));
      const response = await harness.app.request(
        `/api/v1/threads/${thread.id}/send`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: sendBody("still sent"),
        },
      );
      expect(response.status).toBe(200);
      expect(await readJson(response)).toMatchObject({
        ok: true,
        delivery: "queued",
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(readFileSync(target, "utf8")).toBe("keep");
    });
  });
});
