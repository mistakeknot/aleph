import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  migratingInfoPath,
  type MigrationHolderInfo,
} from "@bb/config/migration-info";
import { afterEach, describe, expect, it } from "vitest";
import { waitForServerHealth } from "../src/launcher.js";
import { createHealthDeadline } from "../src/migration-wait.js";

const LAUNCH_ID = "launch-1";
const tempDirs: string[] = [];
const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "bb-health-wait-"));
  tempDirs.push(directory);
  return join(directory, "bb.db");
}

function writeInfo(path: string): void {
  writeFileSync(
    migratingInfoPath(path),
    JSON.stringify({
      pid: process.pid,
      token: "t",
      databaseBytes: 1,
      expectedMs: 1,
      phase: "migrating",
      updatedAt: 1,
    }),
  );
}

function removeInfo(path: string): void {
  try {
    unlinkSync(migratingInfoPath(path));
  } catch {}
}

function createClock() {
  let current = 1_000_000;
  return {
    now: () => current,
    sleep: async (ms: number) => {
      current += ms;
    },
    advance: (ms: number) => {
      current += ms;
    },
  };
}

async function listenHealth(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<string> {
  const server = createServer(handler);
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  closers.push(
    () =>
      new Promise<void>((resolvePromise, reject) => {
        server.close((error) => (error ? reject(error) : resolvePromise()));
      }),
  );
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Expected a TCP address");
  }
  return `http://127.0.0.1:${address.port}/health`;
}

function answerLaunchId(response: ServerResponse): void {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ ok: true, launchId: LAUNCH_ID }));
}

function fakeMigration(pid: number): MigrationHolderInfo {
  return {
    pid,
    token: "t",
    databaseBytes: 1,
    expectedMs: 1,
    phase: "migrating",
    updatedAt: 1,
  };
}

describe("createHealthDeadline", () => {
  it("expires after the timeout when no migration is running", () => {
    const clock = createClock();
    const deadline = createHealthDeadline({
      databasePath: "/db",
      now: clock.now,
      readMigration: () => null,
      timeoutMs: 60_000,
    });
    expect(deadline.isExpired()).toBe(false);
    clock.advance(60_000);
    expect(deadline.isExpired()).toBe(false);
    clock.advance(1);
    expect(deadline.isExpired()).toBe(true);
    expect(deadline.migrationElapsedMs()).toBe(0);
  });

  it("ignores migrations when no database path is given", () => {
    const clock = createClock();
    const deadline = createHealthDeadline({
      databasePath: null,
      now: clock.now,
      readMigration: () => fakeMigration(1),
      timeoutMs: 60_000,
    });
    clock.advance(60_001);
    expect(deadline.isExpired()).toBe(true);
  });

  it("slides the deadline while a migration is running", () => {
    const clock = createClock();
    let migrating = true;
    const deadline = createHealthDeadline({
      databasePath: "/db",
      now: clock.now,
      readMigration: () => (migrating ? fakeMigration(1) : null),
      timeoutMs: 60_000,
    });
    for (let step = 0; step < 100; step += 1) {
      clock.advance(10_000);
      expect(deadline.isExpired()).toBe(false);
    }
    expect(deadline.migrationElapsedMs()).toBe(990_000);
    migrating = false;
    clock.advance(60_000);
    expect(deadline.isExpired()).toBe(false);
    clock.advance(1);
    expect(deadline.isExpired()).toBe(true);
  });

  it("stops sliding once the migration exceeds the cap", () => {
    const clock = createClock();
    const deadline = createHealthDeadline({
      capMs: 300_000,
      databasePath: "/db",
      now: clock.now,
      readMigration: () => fakeMigration(1),
      timeoutMs: 60_000,
    });
    expect(deadline.isExpired()).toBe(false);
    for (let step = 0; step < 30; step += 1) {
      clock.advance(10_000);
      expect(deadline.isExpired()).toBe(false);
    }
    clock.advance(10_000);
    expect(deadline.isExpired()).toBe(false);
    clock.advance(60_000);
    expect(deadline.isExpired()).toBe(true);
  });

  it("reports progress at the configured interval", () => {
    const clock = createClock();
    const reported: number[] = [];
    const deadline = createHealthDeadline({
      databasePath: "/db",
      now: clock.now,
      onProgress: (_info, elapsedMs) => reported.push(elapsedMs),
      progressIntervalMs: 10_000,
      readMigration: () => fakeMigration(1),
      timeoutMs: 60_000,
    });
    for (let step = 0; step < 5; step += 1) {
      deadline.isExpired();
      clock.advance(4_000);
    }
    expect(reported).toEqual([0, 12_000]);
  });
});

describe("waitForServerHealth during a migration", () => {
  it("survives a 250 second migration that outlasts the 60 second timeout", async () => {
    const clock = createClock();
    const path = databasePath();
    const startedAt = clock.now();
    const migrationMs = 250_000;
    writeInfo(path);
    const url = await listenHealth((_request, response) => {
      if (clock.now() - startedAt < migrationMs) {
        response.writeHead(503);
        response.end();
        return;
      }
      removeInfo(path);
      answerLaunchId(response);
    });
    await expect(
      waitForServerHealth({
        childProcess: null,
        databasePath: path,
        expectedLaunchId: LAUNCH_ID,
        now: clock.now,
        sleep: clock.sleep,
        timeoutMs: 60_000,
        url,
      }),
    ).resolves.toBeUndefined();
    expect(clock.now() - startedAt).toBeGreaterThanOrEqual(migrationMs);
  }, 60_000);

  it("times out at 60 seconds without the migration marker", async () => {
    const clock = createClock();
    const path = databasePath();
    const startedAt = clock.now();
    const url = await listenHealth((_request, response) => {
      if (clock.now() - startedAt < 250_000) {
        response.writeHead(503);
        response.end();
        return;
      }
      answerLaunchId(response);
    });
    await expect(
      waitForServerHealth({
        childProcess: null,
        databasePath: path,
        expectedLaunchId: LAUNCH_ID,
        now: clock.now,
        sleep: clock.sleep,
        timeoutMs: 60_000,
        url,
      }),
    ).rejects.toThrow(/Timed out waiting for health/u);
    expect(clock.now() - startedAt).toBeLessThan(65_000);
  }, 60_000);

  it("still times out when the migration finishes but the server never answers", async () => {
    const clock = createClock();
    const path = databasePath();
    const startedAt = clock.now();
    writeInfo(path);
    const url = await listenHealth((_request, response) => {
      if (clock.now() - startedAt >= 120_000) removeInfo(path);
      response.writeHead(503);
      response.end();
    });
    await expect(
      waitForServerHealth({
        childProcess: null,
        databasePath: path,
        expectedLaunchId: LAUNCH_ID,
        now: clock.now,
        sleep: clock.sleep,
        timeoutMs: 60_000,
        url,
      }),
    ).rejects.toThrow(/Timed out waiting for health/u);
    const elapsed = clock.now() - startedAt;
    expect(elapsed).toBeGreaterThanOrEqual(180_000);
    expect(elapsed).toBeLessThan(185_000);
  }, 60_000);
});
