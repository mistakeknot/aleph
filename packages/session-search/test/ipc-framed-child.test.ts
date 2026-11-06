import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  decodeJsonPayload,
  FRAME_HEADER_BYTES,
  FramedChild,
  MAX_FRAME_PAYLOAD_BYTES,
  TRANSPORT_READ_AHEAD_BYTES,
  type FramedChildOptions,
} from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const packageDir = join(here, "..");
const childScript = join(here, "support", "frame-child.ts");
const parentScript = join(here, "support", "frame-parent.ts");
const MIB = 1024 * 1024;
const RSS_BOUND_BYTES = 16 * MIB;

const started: FramedChild[] = [];

afterEach(async () => {
  await Promise.all(started.splice(0).map((child) => child.kill()));
});

function launch(
  mode: string,
  amount: number | null,
  frames: Buffer[] = [],
  extra: Partial<FramedChildOptions> = {},
): FramedChild {
  const child = new FramedChild({
    args: [
      "--import",
      "tsx",
      childScript,
      mode,
      ...(amount === null ? [] : [String(amount)]),
    ],
    cwd: packageDir,
    onFrame: (payload) => frames.push(payload),
    ...extra,
  });
  started.push(child);
  return child;
}

async function until(
  condition: () => boolean,
  limitMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + limitMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not reached");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("supervised child over dedicated pipes", () => {
  it("echoes JSON frames through fd 3 and fd 4", async () => {
    const frames: Buffer[] = [];
    const child = launch("echo", null, frames);
    await child.sendJson({ hello: "world", n: [1, 2, 3] });
    await child.sendJson({ second: true });
    await until(() => frames.length === 2);
    expect(frames.map((frame) => decodeJsonPayload(frame))).toEqual([
      { hello: "world", n: [1, 2, 3] },
      { second: true },
    ]);
    const exit = await child.close(5000);
    expect(exit.cause).toBe("exited");
    expect(exit.code).toBe(0);
    expect(exit.violation).toBeNull();
  });

  it("round-trips a payload of exactly 8 MiB", async () => {
    const frames: Buffer[] = [];
    const child = launch("echo", null, frames);
    const payload = Buffer.alloc(MAX_FRAME_PAYLOAD_BYTES, 0x5a);
    await child.send(payload);
    await until(() => frames.length === 1);
    expect(frames[0]?.byteLength).toBe(MAX_FRAME_PAYLOAD_BYTES);
    expect(frames[0]?.equals(payload)).toBe(true);
    expect(child.stats().peakBufferedBytes).toBe(
      FRAME_HEADER_BYTES + MAX_FRAME_PAYLOAD_BYTES,
    );
    await child.close(5000);
  });

  it("accepts an 8 MiB frame streamed by the child and keeps the child alive", async () => {
    const frames: Buffer[] = [];
    const child = launch("exact", MAX_FRAME_PAYLOAD_BYTES, frames);
    await until(() => frames.length === 1);
    expect(frames[0]?.byteLength).toBe(MAX_FRAME_PAYLOAD_BYTES);
    expect(child.alive).toBe(true);
    const killed = await child.kill();
    expect(killed.alreadyExited).toBe(false);
  });

  it("rejects an 8 MiB plus one byte frame at the header and kills the sender", async () => {
    const frames: Buffer[] = [];
    const child = launch("exact", MAX_FRAME_PAYLOAD_BYTES + 1, frames);
    const pid = child.pid ?? 0;
    const exit = await child.exited;
    expect(exit.cause).toBe("protocol_violation");
    expect(exit.violation).toMatchObject({
      reason: "frame_too_large",
      advertisedBytes: MAX_FRAME_PAYLOAD_BYTES + 1,
    });
    expect(exit.signal).toBe("SIGKILL");
    expect(frames).toHaveLength(0);
    expect(alive(pid)).toBe(false);
    expect(child.stats().peakBufferedBytes).toBe(FRAME_HEADER_BYTES);
  });

  it("rejects a child advertising 64 MiB before accumulating any body", async () => {
    const frames: Buffer[] = [];
    const violations: string[] = [];
    const child = launch("advertise", 64 * MIB, frames, {
      onViolation: (violation) => violations.push(violation.reason),
    });
    const pid = child.pid ?? 0;
    const exit = await child.exited;
    const stats = child.stats();
    expect(violations).toEqual(["frame_too_large"]);
    expect(exit.cause).toBe("protocol_violation");
    expect(exit.violation?.advertisedBytes).toBe(64 * MIB);
    expect(exit.signal).toBe("SIGKILL");
    expect(frames).toHaveLength(0);
    expect(stats.peakBufferedBytes).toBe(FRAME_HEADER_BYTES);
    expect(stats.bufferedBytes).toBe(0);
    expect(stats.bytesReceived).toBeLessThanOrEqual(
      FRAME_HEADER_BYTES + TRANSPORT_READ_AHEAD_BYTES,
    );
    expect(stats.largestChunkBytes).toBeLessThanOrEqual(
      FRAME_HEADER_BYTES + TRANSPORT_READ_AHEAD_BYTES,
    );
    expect(exit.reapLatencyMs).not.toBeNull();
    expect(exit.reapLatencyMs ?? Infinity).toBeLessThan(1000);
    expect(alive(pid)).toBe(false);
  });

  it("bounds read-ahead when the header and a large body arrive in one write", async () => {
    const child = launch("advertise-joined", 64 * MIB);
    const exit = await child.exited;
    const stats = child.stats();
    expect(exit.violation?.reason).toBe("frame_too_large");
    expect(stats.peakBufferedBytes).toBe(FRAME_HEADER_BYTES);
    expect(stats.largestChunkBytes).toBeGreaterThan(FRAME_HEADER_BYTES);
    expect(stats.largestChunkBytes).toBeLessThanOrEqual(
      TRANSPORT_READ_AHEAD_BYTES,
    );
    expect(stats.bytesReceived).toBeLessThanOrEqual(
      FRAME_HEADER_BYTES + TRANSPORT_READ_AHEAD_BYTES,
    );
  });

  it("treats a zero-length frame as a violation and kills the sender", async () => {
    const child = launch("empty", null);
    const exit = await child.exited;
    expect(exit.cause).toBe("protocol_violation");
    expect(exit.violation?.reason).toBe("empty_frame");
    expect(exit.signal).toBe("SIGKILL");
  });

  it("reports a body cut short by the child exiting", async () => {
    const frames: Buffer[] = [];
    const child = launch("truncate", 100, frames);
    const exit = await child.exited;
    expect(exit.cause).toBe("protocol_violation");
    expect(exit.violation).toMatchObject({
      reason: "truncated_body",
      advertisedBytes: 100,
    });
    expect(exit.code).toBe(0);
    expect(frames).toHaveLength(0);
  });

  it("reports a header cut short by the child exiting", async () => {
    const child = launch("partial-header", null);
    const exit = await child.exited;
    expect(exit.cause).toBe("protocol_violation");
    expect(exit.violation?.reason).toBe("truncated_header");
  });

  it("reassembles a frame the child writes one byte at a time", async () => {
    const frames: Buffer[] = [];
    const child = launch("fragment", null, frames);
    await until(() => frames.length === 1);
    expect(frames[0]?.toString()).toBe("fragmented");
    expect(child.stats().largestChunkBytes).toBeLessThan(
      FRAME_HEADER_BYTES + "fragmented".length,
    );
  });

  it("delivers several frames written in a single burst", async () => {
    const frames: Buffer[] = [];
    const child = launch("burst", null, frames);
    const exit = await child.exited;
    expect(frames.map(String)).toEqual(["one", "two", "three"]);
    expect(exit.cause).toBe("exited");
    expect(exit.violation).toBeNull();
    expect(child.stats().framesReceived).toBe(3);
  });

  it("reports a child exit code without a violation", async () => {
    const child = launch("exit", 7);
    const exit = await child.exited;
    expect(exit.cause).toBe("exited");
    expect(exit.code).toBe(7);
    expect(exit.violation).toBeNull();
  });

  it("kills and reaps a hung child and reports the latency", async () => {
    const frames: Buffer[] = [];
    const child = launch("hang", null, frames);
    await until(() => frames.length === 1);
    const pid = child.pid ?? 0;
    const result = await child.kill();
    const exit = await child.exited;
    expect(result.alreadyExited).toBe(false);
    expect(result.reapLatencyMs).toBeLessThan(1000);
    expect(exit.cause).toBe("killed");
    expect(exit.signal).toBe("SIGKILL");
    expect(exit.reapLatencyMs).toBe(result.reapLatencyMs);
    expect(alive(pid)).toBe(false);
    expect(child.alive).toBe(false);
    expect((await child.kill()).alreadyExited).toBe(true);
  });

  it("closes a cooperative child by ending its input", async () => {
    const child = launch("echo", null);
    const exit = await child.close(5000);
    expect(exit.cause).toBe("exited");
    expect(exit.code).toBe(0);
    expect(exit.killRequestedAtMs).toBeNull();
  });

  it("kills a child that ignores the end of its input after the grace period", async () => {
    const child = launch("hang", null);
    await until(() => child.stats().framesReceived === 1);
    const exit = await child.close(100);
    expect(exit.cause).toBe("killed");
    expect(exit.signal).toBe("SIGKILL");
  });

  it("refuses to send after the child has exited and rejects oversize payloads", async () => {
    const child = launch("exit", 0);
    await child.exited;
    await expect(child.sendJson({ late: true })).rejects.toThrow();
    const live = launch("hang", null);
    expect(() => live.send(Buffer.alloc(MAX_FRAME_PAYLOAD_BYTES + 1))).toThrow(
      "frame_too_large",
    );
  });

  it("reports a spawn failure", async () => {
    const child = new FramedChild({
      args: [],
      command: "/nonexistent/bb-session-search-child",
      onFrame: () => {},
    });
    const exit = await child.exited;
    expect(exit.cause).toBe("spawn_failed");
  });
});

interface ParentReport {
  mode: string;
  advertised: number;
  baselineRss: number;
  peakRss: number;
  rssIncreaseBytes: number;
  cause: string;
  reason: string | null;
  reapLatencyMs: number | null;
  peakBufferedBytes: number;
  largestChunkBytes: number;
  bytesReceived: number;
}

function runParent(mode: string, advertised: number): ParentReport {
  const run = spawnSync(
    process.execPath,
    ["--expose-gc", "--import", "tsx", parentScript, mode, String(advertised)],
    { encoding: "utf8", cwd: packageDir, timeout: 60_000 },
  );
  expect(run.status, run.stderr).toBe(0);
  return JSON.parse(
    run.stdout.trim().split("\n").pop() ?? "{}",
  ) as ParentReport;
}

describe("parent memory while a child advertises 64 MiB", () => {
  it("keeps a dedicated minimal parent under 16 MiB baseline-to-peak RSS", () => {
    const report = runParent("guarded", 64 * MIB);
    process.stderr.write(
      `[ipc-frame] guarded parent: baseline ${report.baselineRss} B, peak ${report.peakRss} B, increase ${report.rssIncreaseBytes} B (limit ${RSS_BOUND_BYTES}); decoder peak buffered ${report.peakBufferedBytes} B (limit ${FRAME_HEADER_BYTES + TRANSPORT_READ_AHEAD_BYTES}), largest chunk ${report.largestChunkBytes} B, bytes received ${report.bytesReceived} B, reap ${report.reapLatencyMs} ms\n`,
    );
    expect(report.cause).toBe("protocol_violation");
    expect(report.reason).toBe("frame_too_large");
    expect(report.rssIncreaseBytes).toBeLessThan(RSS_BOUND_BYTES);
    expect(report.peakBufferedBytes).toBeLessThanOrEqual(
      FRAME_HEADER_BYTES + TRANSPORT_READ_AHEAD_BYTES,
    );
    expect(report.bytesReceived).toBeLessThanOrEqual(
      FRAME_HEADER_BYTES + TRANSPORT_READ_AHEAD_BYTES,
    );
    expect(report.reapLatencyMs ?? Infinity).toBeLessThan(1000);
  }, 90_000);

  it("shows the harness would catch a parent that buffers the advertised body", () => {
    const report = runParent("naive", 64 * MIB);
    process.stderr.write(
      `[ipc-frame] naive control parent: baseline ${report.baselineRss} B, peak ${report.peakRss} B, increase ${report.rssIncreaseBytes} B, buffered ${report.peakBufferedBytes} B\n`,
    );
    expect(report.peakBufferedBytes).toBeGreaterThanOrEqual(64 * MIB);
    expect(report.rssIncreaseBytes).toBeGreaterThan(RSS_BOUND_BYTES);
  }, 90_000);
});
