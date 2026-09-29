import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildRendererConsoleRecord,
  createRendererLogWriter,
  parseRendererDiagnosticEvent,
} from "../src/aleph-renderer-log.js";
import { registerAlephRendererLog } from "../src/aleph-renderer-log-main.js";
import { BB_DESKTOP_ALEPH_DIAGNOSTIC_CHANNEL } from "../src/aleph-renderer-log-ipc.js";

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "aleph-renderer-log-"));
});

afterEach(async () => {
  await rm(directory, { force: true, recursive: true });
});

function clockAt(iso: string): { now: () => Date; set: (iso: string) => void } {
  let current = new Date(iso);
  return {
    now: () => current,
    set: (next) => {
      current = new Date(next);
    },
  };
}

describe("renderer log writer", () => {
  it("writes one JSON line per record into a file named for the local day", async () => {
    const clock = clockAt("2026-09-29T10:00:00");
    const writer = createRendererLogWriter({ directory, now: clock.now });
    writer.write({ kind: "a" });
    writer.write({ kind: "b" });
    await writer.flush();
    expect(await readdir(directory)).toEqual(["aleph-renderer-2026-09-29.log"]);
    const lines = (
      await readFile(join(directory, "aleph-renderer-2026-09-29.log"), "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(lines.map((line) => line.kind)).toEqual(["a", "b"]);
  });

  it("rolls to a new file each day and keeps only the newest five days", async () => {
    const clock = clockAt("2026-09-20T10:00:00");
    const writer = createRendererLogWriter({
      directory,
      now: clock.now,
      retentionDays: 5,
    });
    for (let day = 20; day <= 29; day += 1) {
      clock.set(`2026-09-${day}T10:00:00`);
      writer.write({ kind: "tick", day });
      await writer.flush();
    }
    expect((await readdir(directory)).sort()).toEqual([
      "aleph-renderer-2026-09-25.log",
      "aleph-renderer-2026-09-26.log",
      "aleph-renderer-2026-09-27.log",
      "aleph-renderer-2026-09-28.log",
      "aleph-renderer-2026-09-29.log",
    ]);
  });

  it("prunes stale files on the first write and leaves unrelated files alone", async () => {
    await writeFile(join(directory, "aleph-renderer-2026-01-01.log"), "old\n");
    await writeFile(join(directory, "notes.txt"), "keep\n");
    await utimes(join(directory, "notes.txt"), new Date(0), new Date(0));
    const writer = createRendererLogWriter({
      directory,
      now: clockAt("2026-09-29T10:00:00").now,
    });
    writer.write({ kind: "a" });
    await writer.flush();
    expect((await readdir(directory)).sort()).toEqual([
      "aleph-renderer-2026-09-29.log",
      "notes.txt",
    ]);
  });

  it("stops at the per-file size cap and records one truncation marker", async () => {
    const writer = createRendererLogWriter({
      directory,
      maxFileBytes: 300,
      now: clockAt("2026-09-29T10:00:00").now,
    });
    for (let index = 0; index < 50; index += 1) {
      writer.write({ kind: "filler", index });
    }
    await writer.flush();
    const text = await readFile(
      join(directory, "aleph-renderer-2026-09-29.log"),
      "utf8",
    );
    const lines = text.trim().split("\n");
    expect(lines.filter((line) => line.includes("log-truncated"))).toHaveLength(
      1,
    );
    expect(lines.at(-1)).toContain("log-truncated");
    expect(lines.length).toBeLessThan(20);
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(300);
  });

  it("writes the truncation marker once across restarts of an already-capped file", async () => {
    const options = {
      directory,
      maxFileBytes: 300,
      now: clockAt("2026-09-29T10:00:00").now,
    };
    const file = join(directory, "aleph-renderer-2026-09-29.log");
    for (let restart = 0; restart < 3; restart += 1) {
      const writer = createRendererLogWriter(options);
      for (let index = 0; index < 30; index += 1) {
        writer.write({ kind: "filler", index });
      }
      await writer.flush();
    }
    const text = await readFile(file, "utf8");
    expect(
      text.split("\n").filter((line) => line.includes("log-truncated")),
    ).toHaveLength(1);
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(300);
  });

  it("does not append a marker to a file that is already at the cap without one", async () => {
    const file = join(directory, "aleph-renderer-2026-09-29.log");
    await writeFile(file, `${"x".repeat(299)}\n`);
    const writer = createRendererLogWriter({
      directory,
      maxFileBytes: 300,
      now: clockAt("2026-09-29T10:00:00").now,
    });
    writer.write({ kind: "late" });
    writer.write({ kind: "later" });
    await writer.flush();
    expect(Buffer.byteLength(await readFile(file, "utf8"))).toBe(300);
  });

  it("resumes the size count from an existing file after a restart", async () => {
    const options = {
      directory,
      maxFileBytes: 300,
      now: clockAt("2026-09-29T10:00:00").now,
    };
    const first = createRendererLogWriter(options);
    for (let index = 0; index < 4; index += 1) {
      first.write({ kind: "filler", index });
    }
    await first.flush();
    const second = createRendererLogWriter(options);
    for (let index = 0; index < 50; index += 1) {
      second.write({ kind: "filler", index });
    }
    await second.flush();
    const size = (
      await readFile(join(directory, "aleph-renderer-2026-09-29.log"), "utf8")
    ).length;
    expect(size).toBeLessThan(500);
  });
});

describe("renderer log redaction", () => {
  const messageBody = "please rotate the prod database password for Acme Corp";
  const bearer = "Bearer abcDEF123456ghiJKL789";
  const opaque = "sk-live-9f8e7d6c5b4a39281706f5e4d3c2b1a0";
  const opaque80 = "A1b2C3d4".repeat(10);
  const reviewerStrings = [
    "attachment filename: private-tax-return.pdf",
    "request failed /api?key=secret",
    "The private prompt says hello",
  ];
  const leakedFragments = [
    "private-tax-return",
    "key=secret",
    "private prompt",
    "says hello",
    "abcDEF123456ghiJKL789",
    opaque,
    opaque80,
    "Acme",
  ];

  it("reduces console text to a category and a code, never free text", () => {
    for (const message of reviewerStrings) {
      expect(buildRendererConsoleRecord({ level: "error", message })).toEqual({
        code: "console_error",
        level: "error",
      });
    }
    expect(
      buildRendererConsoleRecord({
        level: "warning",
        message: "Uncaught TypeError: cannot read secret of undefined",
      }),
    ).toEqual({ code: "TypeError", level: "warning" });
    expect(
      buildRendererConsoleRecord({
        level: "error",
        message: "ERR_CONNECTION_LOST: host private.example",
      }),
    ).toEqual({ code: "ERR_CONNECTION_LOST", level: "error" });
    expect(
      buildRendererConsoleRecord({
        level: "error",
        message: `${bearer} ${opaque}`,
      })?.code,
    ).toBe("console_error");
  });

  it("drops info and debug console messages", () => {
    for (const level of ["info", "debug"] as const) {
      expect(buildRendererConsoleRecord({ level, message: "hi" })).toBeNull();
    }
  });

  it("rejects free text, opaque strings and non-id values in token fields", () => {
    const base = {
      at: 1,
      kind: "composer-send-state",
      previous: null,
      runtimeStatus: "active",
      state: "ready",
      threadId: "thr_abc",
    };
    expect(parseRendererDiagnosticEvent(base)).not.toBeNull();
    const bad = [
      { threadId: opaque80 },
      { threadId: "thr_abc private prompt" },
      { threadId: "abc" },
      { runtimeStatus: opaque80 },
      { runtimeStatus: "has spaces and a message body" },
    ];
    for (const override of bad) {
      expect(parseRendererDiagnosticEvent({ ...base, ...override })).toBeNull();
    }
    const close = {
      at: 1,
      code: 1006,
      kind: "socket-close",
      pongPending: false,
      reason: null,
      wasClean: false,
    };
    expect(parseRendererDiagnosticEvent(close)).not.toBeNull();
    for (const reason of [
      opaque80,
      "Bearer abc",
      "The private prompt says hello",
    ]) {
      expect(parseRendererDiagnosticEvent({ ...close, reason })).toBeNull();
    }
    expect(
      parseRendererDiagnosticEvent({
        at: 1,
        decisions: [
          {
            dataUpdatedAt: 1,
            fetching: false,
            invalidated: true,
            queryName: "thread",
            subjectId: opaque80,
          },
        ],
        disconnectedAt: 1,
        invalidatedCount: 1,
        kind: "reconnect-invalidation",
        skippedCount: 0,
      }),
    ).toBeNull();
  });

  it("strips unknown fields from diagnostic events", () => {
    const parsed = parseRendererDiagnosticEvent({
      at: 1,
      kind: "composer-send-state",
      previous: null,
      runtimeStatus: "active",
      state: "ready",
      text: messageBody,
      threadId: "thr_abc",
    });
    expect(JSON.stringify(parsed)).not.toContain("Acme");
    expect(parseRendererDiagnosticEvent({ kind: "unknown" })).toBeNull();
  });

  describe("through the IPC and console paths", () => {
    interface FakeFrame {
      isDestroyed: () => boolean;
    }
    type IpcHandler = (
      event: { sender: { id: number }; senderFrame: FakeFrame | null },
      payload: unknown,
    ) => void;

    function setup() {
      const handlers = new Map<string, IpcHandler>();
      const consoleHandlers: Array<(event: object) => void> = [];
      const mainFrame: FakeFrame = { isDestroyed: () => false };
      const writer = createRendererLogWriter({
        directory,
        now: clockAt("2026-09-29T10:00:00").now,
      });
      const log = registerAlephRendererLog({
        getApplicationMainFrame: (id: number) =>
          id === 7 ? (mainFrame as never) : null,
        ipcMain: {
          on: (channel: string, handler: IpcHandler) => {
            handlers.set(channel, handler);
          },
        } as never,
        writer,
      });
      log.attachConsole({
        on: (_name: string, handler: (event: object) => void) => {
          consoleHandlers.push(handler);
        },
      } as never);
      const send = handlers.get(BB_DESKTOP_ALEPH_DIAGNOSTIC_CHANNEL);
      if (send === undefined) {
        throw new Error("diagnostic handler was not registered");
      }
      const readLog = async (): Promise<string> => {
        await writer.flush();
        try {
          return await readFile(
            join(directory, "aleph-renderer-2026-09-29.log"),
            "utf8",
          );
        } catch {
          return "";
        }
      };
      return { consoleHandlers, mainFrame, readLog, send };
    }

    const event = (threadId: string) => ({
      at: 5,
      kind: "composer-send-state",
      previous: null,
      runtimeStatus: "idle",
      state: "blocked-loading-pending-interactions",
      threadId,
    });

    it("never writes a message body, token or console text", async () => {
      const { consoleHandlers, mainFrame, readLog, send } = setup();
      send(
        { sender: { id: 7 }, senderFrame: mainFrame },
        {
          ...event("thr_abc"),
          authorization: bearer,
          prompt: messageBody,
          text: messageBody,
        },
      );
      send({ sender: { id: 7 }, senderFrame: mainFrame }, event(opaque80));
      const messages = [
        ...reviewerStrings,
        `send failed ${bearer} token=${opaque} body=${messageBody}`,
        opaque80,
      ];
      for (const handler of consoleHandlers) {
        for (const message of messages) {
          handler({
            level: "error",
            lineNumber: 12,
            message,
            sourceId: `https://x/app.js?auth=${opaque}`,
          });
        }
      }
      const text = await readLog();
      expect(text).toContain("blocked-loading-pending-interactions");
      expect(text).toContain('"kind":"console"');
      expect(text).toContain('"code":"console_error"');
      expect(text).toContain('"count":5');
      for (const fragment of leakedFragments) {
        expect(text).not.toContain(fragment);
      }
      expect(text).not.toContain("app.js");
    });

    it("rejects untrusted senders, subframes, null and destroyed frames", async () => {
      const { mainFrame, readLog, send } = setup();
      const subframe: FakeFrame = { isDestroyed: () => false };
      send(
        { sender: { id: 99 }, senderFrame: mainFrame },
        event("thr_untrusted"),
      );
      send({ sender: { id: 7 }, senderFrame: subframe }, event("thr_subframe"));
      send({ sender: { id: 7 }, senderFrame: null }, event("thr_nullframe"));
      send(
        { sender: { id: 7 }, senderFrame: { isDestroyed: () => true } },
        event("thr_destroyed"),
      );
      expect(await readLog()).toBe("");
      send({ sender: { id: 7 }, senderFrame: mainFrame }, event("thr_trusted"));
      expect(await readLog()).toContain("thr_trusted");
    });
  });
});
