import { mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildRendererConsoleRecord,
  createRendererLogWriter,
  parseRendererDiagnosticEvent,
  RENDERER_CONSOLE_MESSAGE_MAX_CHARS,
  scrubRendererLogText,
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
    expect(lines.filter((line) => line.includes("log-truncated"))).toHaveLength(1);
    expect(lines.at(-1)).toContain("log-truncated");
    expect(lines.length).toBeLessThan(20);
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

  it("scrubs tokens, secret assignments and URL queries from console text", () => {
    const scrubbed = scrubRendererLogText(
      `fetch failed https://bb.example/api?token=${opaque} ${bearer} api_key=${opaque} password: "hunter2hunter2"`,
    );
    expect(scrubbed).not.toContain(opaque);
    expect(scrubbed).not.toContain("abcDEF123456ghiJKL789");
    expect(scrubbed).not.toContain("hunter2");
    expect(scrubbed).toContain("https://bb.example/api");
  });

  it("keeps only the first line and truncates long console text", () => {
    const record = buildRendererConsoleRecord({
      level: "error",
      line: 3,
      message: `${"x ".repeat(400)}\nsecond line with detail`,
      sourceId: "https://bb.example/assets/app.js?token=abc",
    });
    expect(record?.message.length).toBeLessThanOrEqual(
      RENDERER_CONSOLE_MESSAGE_MAX_CHARS,
    );
    expect(record?.message).not.toContain("second line");
    expect(record?.sourceFile).toBe("app.js");
  });

  it("drops info and debug console messages", () => {
    for (const level of ["info", "debug"] as const) {
      expect(
        buildRendererConsoleRecord({ level, line: 1, message: "hi", sourceId: "" }),
      ).toBeNull();
    }
  });

  it("strips unknown fields from diagnostic events and rejects malformed ones", () => {
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
    expect(
      parseRendererDiagnosticEvent({
        at: 1,
        kind: "composer-send-state",
        previous: null,
        runtimeStatus: "has spaces and a message body",
        state: "ready",
        threadId: "thr_abc",
      }),
    ).toBeNull();
    expect(parseRendererDiagnosticEvent({ kind: "unknown" })).toBeNull();
  });

  it("never writes a message body or token that is fed through the IPC and console paths", async () => {
    type IpcHandler = (event: { sender: { id: number } }, payload: unknown) => void;
    const handlers = new Map<string, IpcHandler>();
    const consoleHandlers: Array<(event: object) => void> = [];
    const writer = createRendererLogWriter({
      directory,
      now: clockAt("2026-09-29T10:00:00").now,
    });
    const log = registerAlephRendererLog({
      ipcMain: {
        on: (channel: string, handler: IpcHandler) => {
          handlers.set(channel, handler);
        },
      } as never,
      isApplicationWebContents: (id) => id === 7,
      writer,
    });
    log.attachConsole({
      on: (_name: string, handler: (event: object) => void) => {
        consoleHandlers.push(handler);
      },
    } as never);

    const send = handlers.get(BB_DESKTOP_ALEPH_DIAGNOSTIC_CHANNEL);
    send?.(
      { sender: { id: 7 } },
      {
        at: 5,
        authorization: bearer,
        kind: "composer-send-state",
        previous: null,
        prompt: messageBody,
        runtimeStatus: "idle",
        state: "blocked-loading-pending-interactions",
        text: messageBody,
        threadId: "thr_abc",
      },
    );
    send?.(
      { sender: { id: 99 } },
      {
        at: 6,
        kind: "composer-send-state",
        previous: null,
        runtimeStatus: "idle",
        state: "ready",
        threadId: "thr_from_untrusted_sender",
      },
    );
    for (const handler of consoleHandlers) {
      handler({
        level: "error",
        lineNumber: 12,
        message: `send failed ${bearer} token=${opaque} body=${messageBody}`,
        sourceId: `https://bb.example/assets/app.js?auth=${opaque}`,
      });
    }
    await writer.flush();

    const text = await readFile(
      join(directory, "aleph-renderer-2026-09-29.log"),
      "utf8",
    );
    expect(text).toContain("blocked-loading-pending-interactions");
    expect(text).toContain('"kind":"console"');
    expect(text).not.toContain("Acme");
    expect(text).not.toContain("rotate the prod");
    expect(text).not.toContain("abcDEF123456ghiJKL789");
    expect(text).not.toContain(opaque);
    expect(text).not.toContain("thr_from_untrusted_sender");
  });
});
