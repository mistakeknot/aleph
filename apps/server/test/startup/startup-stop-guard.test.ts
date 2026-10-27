import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { startupMarkerPath } from "@bb/config/migration-info";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  deferStopDuringDatabaseStartup,
  type StartupSignalSource,
  type StartupStopSignal,
} from "../../src/startup-stop-guard.js";

const childScript = new URL("./stop-guard-child.mts", import.meta.url);
const tempDirs: string[] = [];

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

interface ChildResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  completed: boolean;
}

async function runStoppedChild(guarded: boolean): Promise<ChildResult> {
  const directory = mkdtempSync(join(tmpdir(), "bb-stop-guard-"));
  tempDirs.push(directory);
  const completionFile = join(directory, "done");
  const child = spawn(
    process.execPath,
    ["--import", "tsx", childScript.pathname],
    {
      cwd: new URL("../..", import.meta.url).pathname,
      env: {
        ...process.env,
        STOP_GUARD_COMPLETION_FILE: completionFile,
        STOP_GUARD_ENABLED: guarded ? "1" : "0",
        STOP_GUARD_BUSY_MS: "1500",
      },
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  let stdout = "";
  const started = new Promise<void>((resolve) => {
    child.stdout.on("data", (chunk: Buffer) => {
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
  await new Promise((resolve) => setTimeout(resolve, 300));
  child.kill("SIGTERM");
  const { code, signal } = await exited;
  return { code, signal, stdout, completed: existsSync(completionFile) };
}

describe("startup stop guard", () => {
  it("lets a migrating child finish before honouring SIGTERM", async () => {
    const result = await runStoppedChild(true);
    expect(result.completed).toBe(true);
    expect(result.signal).toBeNull();
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("stopped-after-migration SIGTERM");
  }, 30_000);

  it("kills an unguarded migrating child mid-migration", async () => {
    const result = await runStoppedChild(false);
    expect(result.completed).toBe(false);
    expect(result.signal).toBe("SIGTERM");
  }, 30_000);

  it("reports no stop and detaches its listeners when nothing was sent", async () => {
    const listeners = new Map<StartupStopSignal, Set<() => void>>();
    const source: StartupSignalSource = {
      on: (signal, listener) => {
        listeners.set(
          signal,
          (listeners.get(signal) ?? new Set()).add(listener),
        );
      },
      off: (signal, listener) => {
        listeners.get(signal)?.delete(listener);
      },
    };
    const guard = deferStopDuringDatabaseStartup({
      logger: { info: () => undefined },
      source,
    });
    expect(listeners.get("SIGTERM")?.size).toBe(1);
    expect(await guard.settle()).toBeNull();
    expect(listeners.get("SIGTERM")?.size).toBe(0);
    expect(listeners.get("SIGINT")?.size).toBe(0);
  });

  it("remembers the first stop signal", async () => {
    const listeners = new Map<StartupStopSignal, () => void>();
    const source: StartupSignalSource = {
      on: (signal, listener) => {
        listeners.set(signal, listener);
      },
      off: () => undefined,
    };
    const messages: string[] = [];
    const guard = deferStopDuringDatabaseStartup({
      logger: {
        info: (_fields: object, message: string) => {
          messages.push(message);
        },
      },
      source,
    });
    listeners.get("SIGINT")?.();
    listeners.get("SIGTERM")?.();
    expect(await guard.settle()).toBe("SIGINT");
    expect(messages).toHaveLength(1);
  });

  it("publishes a startup marker at install and clears it on settle", async () => {
    const directory = mkdtempSync(join(tmpdir(), "bb-stop-guard-marker-"));
    tempDirs.push(directory);
    const databasePath = join(directory, "bb.db");
    const source: StartupSignalSource = {
      on: () => undefined,
      off: () => undefined,
    };
    const guard = deferStopDuringDatabaseStartup({
      databasePath,
      logger: { info: () => undefined },
      source,
    });
    expect(existsSync(startupMarkerPath(databasePath))).toBe(true);
    await guard.settle();
    expect(existsSync(startupMarkerPath(databasePath))).toBe(false);
  });

  it("clears the startup marker when abandoned", () => {
    const directory = mkdtempSync(join(tmpdir(), "bb-stop-guard-marker-"));
    tempDirs.push(directory);
    const databasePath = join(directory, "bb.db");
    const source: StartupSignalSource = {
      on: () => undefined,
      off: () => undefined,
    };
    const guard = deferStopDuringDatabaseStartup({
      databasePath,
      logger: { info: () => undefined },
      source,
    });
    expect(existsSync(startupMarkerPath(databasePath))).toBe(true);
    guard.abandon();
    expect(existsSync(startupMarkerPath(databasePath))).toBe(false);
  });
});
