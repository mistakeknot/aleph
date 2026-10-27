import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { terminateProcessIfRunning } from "../src/launcher.js";

const fixture = new URL(
  "./fixtures/startup-marker-process.mjs",
  import.meta.url,
).pathname;
const tempDirs: string[] = [];

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

interface TerminationOutcome {
  code: number | null;
  signal: NodeJS.Signals | null;
  completed: boolean;
  stdout: string;
}

async function terminateFixture(
  mode: "early" | "late" | "none",
  busyMs: number,
): Promise<TerminationOutcome> {
  const directory = mkdtempSync(join(tmpdir(), "bb-terminate-startup-"));
  tempDirs.push(directory);
  const databasePath = join(directory, "bb.db");
  const doneFile = join(directory, "done");
  const child: ChildProcess = spawn(process.execPath, [fixture], {
    env: {
      ...process.env,
      FIXTURE_BUSY_MS: String(busyMs),
      FIXTURE_DB: databasePath,
      FIXTURE_DONE_FILE: doneFile,
      FIXTURE_MARKER_MODE: mode,
    },
    stdio: ["ignore", "pipe", "ignore"],
  });
  let stdout = "";
  const started = new Promise<void>((resolve) => {
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      if (stdout.includes("started")) resolve();
    });
  });
  const exited = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve) => {
    child.on("exit", (code, signal) => resolve({ code, signal }));
  });
  await started;
  await terminateProcessIfRunning({
    childProcess: child,
    migrationDatabasePath: databasePath,
    processName: "server",
    signal: "SIGTERM",
  });
  const { code, signal } = await exited;
  return { code, signal, completed: existsSync(doneFile), stdout };
}

describe("terminating a server that is starting up", () => {
  it("waits when the startup marker was published before the signal", async () => {
    const outcome = await terminateFixture("early", 7_000);
    expect(outcome.completed).toBe(true);
    expect(outcome.signal).toBeNull();
    expect(outcome.code).toBe(0);
    expect(outcome.stdout).toContain("stopped-after-work");
  }, 30_000);

  it("waits when the marker appears after the signal but before the kill", async () => {
    const outcome = await terminateFixture("late", 7_000);
    expect(outcome.completed).toBe(true);
    expect(outcome.signal).toBeNull();
    expect(outcome.code).toBe(0);
    expect(outcome.stdout).toContain("stopped-after-work");
  }, 30_000);

  it("still kills a server that never publishes a marker", async () => {
    const outcome = await terminateFixture("none", 20_000);
    expect(outcome.completed).toBe(false);
    expect(outcome.signal).toBe("SIGKILL");
  }, 30_000);
});
