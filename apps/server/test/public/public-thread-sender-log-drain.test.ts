import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => ({ afterClose: null as (() => void) | null }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      const close = handle.close.bind(handle);
      handle.close = async () => {
        await close();
        const run = hooks.afterClose;
        hooks.afterClose = null;
        run?.();
      };
      return handle;
    },
  };
});

const { SENDER_LOG_FILE_NAME, createSenderLogSink } =
  await import("../../src/services/threads/sender-record.js");

const entry = {
  route: "send" as const,
  requestedThreadId: "t",
  threadId: "t",
  messageSequence: 1,
  queuedMessageId: null,
  sender: {
    kind: "api" as const,
    verified: false,
    operatorSession: false,
    claimedSenderThreadId: null,
    callerThreadHeader: null,
    pluginId: null,
    surface: "api" as const,
    gateAuth: null,
    accessRoute: null,
    machineId: null,
  },
  textSha256: "0".repeat(64),
  textLength: 0,
  inputChunkCount: 1,
};

async function lineCount(file: string, want: number): Promise<number> {
  const deadline = Date.now() + 5000;
  let count = 0;
  while (Date.now() < deadline) {
    count = existsSync(file)
      ? readFileSync(file, "utf8").split("\n").filter(Boolean).length
      : 0;
    if (count >= want) return count;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  return count;
}

describe("sender log drain cleanup", () => {
  it("writes a record enqueued at any microtask offset after the last append, without a flush", async () => {
    for (let offset = 0; offset <= 12; offset += 1) {
      const dir = mkdtempSync(join(tmpdir(), "sender-log-drain-"));
      try {
        const sink = createSenderLogSink({
          dataDir: dir,
          logger: { debug() {}, info() {}, error() {}, warn() {} },
        });
        hooks.afterClose = () => {
          let remaining = offset;
          const step = () => {
            if (remaining === 0) {
              sink.record({ ...entry, messageSequence: 2 });
              return;
            }
            remaining -= 1;
            queueMicrotask(step);
          };
          step();
        };
        sink.record(entry);
        const file = join(dir, "sender-log", SENDER_LOG_FILE_NAME);
        expect(await lineCount(file, 2)).toBe(2);
      } finally {
        hooks.afterClose = null;
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });
});
