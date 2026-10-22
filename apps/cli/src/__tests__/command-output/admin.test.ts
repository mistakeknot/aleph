import { describe, expect, it, vi } from "vitest";
import {
  collectLogLines,
  collectLogPayloads,
  runCommand,
  setupCommandOutputTestEnvironment,
  stubServerApi,
} from "../helpers/command-output-harness.js";
import type { CommandRegistrar } from "../helpers/command-output-harness.js";
import { registerAdminCommands } from "../../commands/admin.js";

const DAY_MS = 24 * 60 * 60 * 1000;

const classification = {
  classes: {
    referenced: { bytes: 4096, count: 2 },
    aborted: { bytes: 512, count: 1 },
  },
  inconsistencies: [{ reason: "row_without_file", segmentId: "seg-b" }],
  missingLiveSegments: ["seg-c"],
};

const status = {
  ...classification,
  coldThreads: 2,
  config: {
    maxThreadBytes: 33554432,
    maxThreadBytesClamped: false,
    minArchivedMs: 14 * DAY_MS,
    mode: "dry-run",
    rehotCooldownMs: 7 * DAY_MS,
  },
  queueDepth: 0,
  segments: { committed: 2, aborted: 1 },
  zstdAvailable: true,
};

describe("bb admin event-archive commands", () => {
  setupCommandOutputTestEnvironment();

  const register: CommandRegistrar = (program) =>
    registerAdminCommands(program, () => "http://server");

  it("prints the archive status with files by class", async () => {
    stubServerApi({
      "v1.system.event-archive.$get": vi.fn(async () => status),
    });

    await runCommand(["admin", "event-archive", "status"], register);

    const lines = collectLogLines(vi.mocked(console.log));
    expect(lines.slice(0, 6)).toEqual([
      "Mode: dry-run",
      "Moves threads archived 14d or longer, up to 33554432 bytes; rehydrated threads wait 7d",
      "Cold threads: 2",
      "Segments: committed 2, aborted 1",
      "Queue depth: 0",
      "zstd: available",
    ]);
    const table = lines.join("\n");
    expect(table).toMatch(/referenced\s+2\s+4096/);
    expect(table).toMatch(/aborted\s+1\s+512/);
    expect(lines.slice(-2)).toEqual([
      "Missing live segment file: seg-c",
      "Inconsistent: seg-b (row_without_file)",
    ]);
  });

  it("prints the status response as JSON", async () => {
    stubServerApi({
      "v1.system.event-archive.$get": vi.fn(async () => status),
    });

    await runCommand(["admin", "event-archive", "status", "--json"], register);

    expect(
      JSON.parse(collectLogPayloads(vi.mocked(console.log)).join("")),
    ).toEqual(status);
  });

  it("rehydrates one thread", async () => {
    const rehydrate = vi.fn(async () => ({
      scope: "thread",
      result: {
        outcome: "rehydrated",
        rowCount: 42,
        segmentId: "seg-a",
        threadId: "thr_one",
        timings: { totalMs: 3 },
      },
    }));
    stubServerApi({ "v1.system.event-archive.rehydrate.$post": rehydrate });

    await runCommand(
      ["admin", "event-archive", "rehydrate", "thr_one"],
      register,
    );

    expect(rehydrate).toHaveBeenCalledWith({ json: { threadId: "thr_one" } });
    expect(collectLogLines(vi.mocked(console.log))).toEqual([
      "Rehydrated 42 events for thr_one.",
    ]);
  });

  it("rehydrates every cold thread and fails when any thread fails", async () => {
    const rehydrate = vi.fn(async () => ({
      scope: "all",
      failed: [{ error: "segment unreadable", threadId: "thr_bad" }],
      rehydrated: 3,
    }));
    stubServerApi({ "v1.system.event-archive.rehydrate.$post": rehydrate });

    await runCommand(
      ["admin", "event-archive", "rehydrate", "--all"],
      register,
    );

    expect(rehydrate).toHaveBeenCalledWith({ json: { all: true } });
    expect(collectLogLines(vi.mocked(console.log))).toEqual([
      "Rehydrated 3 threads.",
      "Failed thr_bad: segment unreadable",
    ]);
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;
  });

  it("fails a --json rehydrate --all when any thread fails", async () => {
    const response = {
      scope: "all",
      failed: [{ error: "segment unreadable", threadId: "thr_bad" }],
      rehydrated: 3,
    };
    stubServerApi({
      "v1.system.event-archive.rehydrate.$post": vi.fn(async () => response),
    });

    await runCommand(
      ["admin", "event-archive", "rehydrate", "--all", "--json"],
      register,
    );

    expect(
      JSON.parse(collectLogPayloads(vi.mocked(console.log)).join("")),
    ).toEqual(response);
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;
  });

  it("rejects a thread id together with --all, and neither", async () => {
    const rehydrate = vi.fn();
    stubServerApi({ "v1.system.event-archive.rehydrate.$post": rehydrate });

    await expect(
      runCommand(
        ["admin", "event-archive", "rehydrate", "thr_one", "--all"],
        register,
      ),
    ).rejects.toThrow("process.exit:1");
    await expect(
      runCommand(["admin", "event-archive", "rehydrate"], register),
    ).rejects.toThrow("process.exit:1");
    expect(rehydrate).not.toHaveBeenCalled();
  });

  it("prints what reconcile repaired", async () => {
    const reconcile = vi.fn(async () => ({
      ...classification,
      orphaned: ["seg-x", "seg-y"],
      repairedCommitted: ["seg-z"],
    }));
    stubServerApi({ "v1.system.event-archive.reconcile.$post": reconcile });

    await runCommand(["admin", "event-archive", "reconcile"], register);

    expect(reconcile).toHaveBeenCalledTimes(1);
    const lines = collectLogLines(vi.mocked(console.log));
    expect(lines.slice(0, 2)).toEqual([
      "Orphaned segments marked: 2",
      "Committed entries repaired: 1",
    ]);
    expect(lines.join("\n")).toMatch(/referenced\s+2\s+4096/);
  });
});
