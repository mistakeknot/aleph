import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  guardLogTransport,
  isLogTransportFailure,
  type GuardableLogTransport,
} from "../src/index.js";

const tempDirs: string[] = [];

afterAll(() => {
  for (const tempDir of tempDirs.splice(0)) {
    fs.rmSync(tempDir, { force: true, recursive: true });
  }
});

function createDataDirWithFullDeviceLog(component: string): string {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-logger-enospc-"));
  tempDirs.push(dataDir);
  const logDir = path.join(dataDir, "logs");
  fs.mkdirSync(logDir, { recursive: true });
  // pino-roll opens `<component>.1.log` first. /dev/full answers every write
  // with ENOSPC, the same errno a full disk returns.
  fs.symlinkSync("/dev/full", path.join(logDir, `${component}.1.log`));
  return dataDir;
}

interface SubprocessResult {
  exitCode: number | null;
  stderr: string;
  stdout: string;
}

function runLoggerScript(
  dataDir: string,
  script: string,
): Promise<SubprocessResult> {
  const env: NodeJS.ProcessEnv = { ...process.env, BB_DATA_DIR: dataDir };
  delete env.VITEST;
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--conditions=source", "--import", "tsx", "-e", script],
      { env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (exitCode) => resolve({ exitCode, stderr, stdout }));
  });
}

const LOGGER_IMPORT = `const { createLogger } = await import("@bb/logger");`;

describe("a log transport that fails with ENOSPC", () => {
  it("does not kill the process while it keeps logging", async () => {
    const dataDir = createDataDirWithFullDeviceLog("probe");
    const result = await runLoggerScript(
      dataDir,
      `(async () => {
        ${LOGGER_IMPORT}
        const logger = createLogger({ component: "probe" });
        for (let i = 0; i < 200; i++) {
          logger.info({ i }, "line " + i);
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        console.log("survived");
      })().catch((error) => { console.error(error); process.exit(9); });`,
    );

    expect(result.stdout).toContain("survived");
    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toContain("Unhandled 'error' event");
    const notices = result.stderr
      .split("\n")
      .filter((line) => line.includes("log transport failed"));
    expect(notices.length).toBeLessThanOrEqual(1);
  }, 30_000);

  it("keeps the real exit code when the process exits right after the failure", async () => {
    const dataDir = createDataDirWithFullDeviceLog("probe");
    const result = await runLoggerScript(
      dataDir,
      `(async () => {
        ${LOGGER_IMPORT}
        const logger = createLogger({ component: "probe" });
        for (let i = 0; i < 50; i++) logger.info({ i }, "burst " + i);
        await new Promise((resolve) => setTimeout(resolve, 100));
        for (let i = 0; i < 50; i++) logger.info({ i }, "late burst " + i);
        process.exit(5);
      })().catch((error) => { console.error(error); process.exit(9); });`,
    );

    expect(result.exitCode).toBe(5);
    expect(result.stderr).not.toContain("_flushSync failed");
  }, 30_000);

  it("keeps the real exit code when the event loop drains on its own", async () => {
    const dataDir = createDataDirWithFullDeviceLog("probe");
    const result = await runLoggerScript(
      dataDir,
      `(async () => {
        ${LOGGER_IMPORT}
        const logger = createLogger({ component: "probe" });
        logger.info("first");
        await new Promise((resolve) => setTimeout(resolve, 150));
        logger.info("second");
        process.exitCode = 3;
      })().catch((error) => { console.error(error); process.exit(9); });`,
    );

    expect(result.exitCode).toBe(3);
  }, 30_000);
});

class FakeTransport extends EventEmitter implements GuardableLogTransport {
  destroyed = false;
  written: string[] = [];
  flushSyncCalls = 0;
  endCalls = 0;
  write(chunk: string): boolean {
    if (this.destroyed) {
      throw new Error("the worker has exited");
    }
    this.written.push(chunk);
    return true;
  }
  flushSync(): void {
    this.flushSyncCalls += 1;
    if (this.destroyed) {
      throw new Error("_flushSync failed");
    }
  }
  end(): void {
    this.endCalls += 1;
  }
}

describe("guardLogTransport", () => {
  it("turns the stream into a sink after its first error and notes it once", () => {
    const stream = new FakeTransport();
    const notices: string[] = [];
    guardLogTransport(stream, { notify: (text) => notices.push(text) });

    const failure = Object.assign(
      new Error("ENOSPC: no space left on device, write"),
      {
        code: "ENOSPC",
      },
    );
    stream.destroyed = true;
    stream.emit("error", failure);
    stream.emit("error", new Error("the worker has exited"));

    expect(() => stream.write("after failure\n")).not.toThrow();
    expect(() => stream.flushSync()).not.toThrow();
    expect(stream.written).toEqual([]);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("ENOSPC");
  });

  it("degrades when flushSync or write throw before any error event arrives", () => {
    const stream = new FakeTransport();
    const notices: string[] = [];
    guardLogTransport(stream, { notify: (text) => notices.push(text) });

    // The worker died but thread-stream has not emitted 'error' yet.
    stream.destroyed = true;
    expect(() => stream.flushSync()).not.toThrow();
    expect(() => stream.write("late\n")).not.toThrow();
    expect(() => stream.end()).not.toThrow();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("_flushSync failed");
  });

  it("swallows a stderr failure while reporting", () => {
    const stream = new FakeTransport();
    guardLogTransport(stream, {
      notify: () => {
        throw new Error("EPIPE");
      },
    });
    expect(() => stream.emit("error", new Error("boom"))).not.toThrow();
  });

  it("passes writes through while the stream is healthy", () => {
    const stream = new FakeTransport();
    guardLogTransport(stream, { notify: () => {} });
    stream.write("ok\n");
    expect(stream.written).toEqual(["ok\n"]);
  });
});

describe("isLogTransportFailure", () => {
  it("recognizes the errors thread-stream raises after its worker dies", () => {
    const outOfRange = Object.assign(
      new RangeError(
        'The value of "offset" is out of range. It must be >= 0 && <= 4194304. Received -2',
      ),
      { code: "ERR_OUT_OF_RANGE" },
    );
    outOfRange.stack = `RangeError [ERR_OUT_OF_RANGE]: x\n    at write (/app/node_modules/.pnpm/thread-stream@3.1.0/node_modules/thread-stream/index.js:423:29)`;
    expect(isLogTransportFailure(outOfRange)).toBe(true);
    expect(isLogTransportFailure(new Error("_flushSync failed"))).toBe(true);
    expect(isLogTransportFailure(new Error("the worker has exited"))).toBe(
      true,
    );
    expect(isLogTransportFailure(new Error("the worker thread exited"))).toBe(
      true,
    );
  });

  it("does not claim unrelated errors", () => {
    expect(isLogTransportFailure(new Error("boom"))).toBe(false);
    expect(isLogTransportFailure(new RangeError("offset"))).toBe(false);
    expect(
      isLogTransportFailure(
        Object.assign(new RangeError("x"), { code: "ERR_OUT_OF_RANGE" }),
      ),
    ).toBe(false);
    expect(isLogTransportFailure("the worker has exited")).toBe(false);
    expect(isLogTransportFailure(null)).toBe(false);
  });
});
