import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  record: vi.fn(),
  roundTrip: new Set<(ms: number) => void>(),
  visibility: new Set<() => void>(),
  visible: true,
  nativeShell: false,
}));

vi.mock("./sdk", () => ({
  sdk: { system: { experimental_recordClientTiming: mocks.record } },
}));
vi.mock("./ws", () => ({
  wsManager: {
    onRoundTrip: (callback: (ms: number) => void) => {
      mocks.roundTrip.add(callback);
      return () => mocks.roundTrip.delete(callback);
    },
  },
}));
vi.mock("./native-shell", () => ({
  isInsideNativeShell: () => mocks.nativeShell,
}));
vi.mock("./document-visibility", () => ({
  isDocumentVisible: () => mocks.visible,
  subscribeToDocumentVisibility: (listener: () => void) => {
    mocks.visibility.add(listener);
    return () => mocks.visibility.delete(listener);
  },
}));

const {
  CLIENT_TIMING_FLUSH_MS,
  CLIENT_TIMING_MAX_QUEUE,
  flushClientTiming,
  installClientTiming,
  markThreadViewed,
  noteStreamApplied,
  noteStreamCommitted,
  recordClientTiming,
  resetClientTimingForTests,
  streamAppliedCountForTests,
  timeSendAck,
} = await import("./client-timing");

let now = 0;

beforeEach(() => {
  vi.useFakeTimers();
  now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  mocks.record.mockReset();
  mocks.record.mockResolvedValue({ ok: true });
  mocks.visible = true;
  mocks.nativeShell = false;
  vi.stubGlobal("location", { hostname: "bb.example" });
  vi.stubGlobal(
    "window",
    Object.assign(new EventTarget(), {
      matchMedia: () => ({ matches: false }),
    }),
  );
});

afterEach(() => {
  resetClientTimingForTests();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("client timing", () => {
  it("batches samples and posts them after the flush interval without identifiers", () => {
    recordClientTiming("send-ack", 180.04);
    recordClientTiming("thread-view", 412.55, true);
    expect(mocks.record).not.toHaveBeenCalled();
    vi.advanceTimersByTime(CLIENT_TIMING_FLUSH_MS);
    expect(mocks.record).toHaveBeenCalledTimes(1);
    expect(mocks.record).toHaveBeenCalledWith(
      {
        device: "desktop",
        surface: "remote",
        samples: [
          { kind: "send-ack", ms: 180 },
          { kind: "thread-view", ms: 412.6, cached: true },
        ],
      },
      undefined,
    );
  });

  it("drops invalid samples and caps the queue", () => {
    recordClientTiming("rtt", Number.NaN);
    recordClientTiming("rtt", -1);
    recordClientTiming("rtt", 600_001);
    flushClientTiming();
    expect(mocks.record).not.toHaveBeenCalled();
    for (let index = 0; index < CLIENT_TIMING_MAX_QUEUE + 5; index += 1) {
      recordClientTiming("rtt", index);
    }
    flushClientTiming();
    expect(mocks.record.mock.calls[0]?.[0].samples).toHaveLength(
      CLIENT_TIMING_MAX_QUEUE,
    );
  });

  it("labels local and mobile clients", () => {
    vi.stubGlobal("location", { hostname: "127.0.0.1" });
    mocks.nativeShell = true;
    recordClientTiming("rtt", 5);
    flushClientTiming();
    expect(mocks.record.mock.calls[0]?.[0]).toMatchObject({
      device: "mobile",
      surface: "local",
    });
  });

  it("swallows a failed post", async () => {
    mocks.record.mockRejectedValue(new Error("offline"));
    recordClientTiming("rtt", 5);
    flushClientTiming();
    await Promise.resolve();
    expect(mocks.record).toHaveBeenCalledTimes(1);
  });

  it("records round trips and flushes with keepalive when the page hides", () => {
    installClientTiming();
    for (const callback of mocks.roundTrip) callback(92);
    mocks.visible = false;
    for (const listener of mocks.visibility) listener();
    expect(mocks.record).toHaveBeenCalledWith(
      expect.objectContaining({ samples: [{ kind: "rtt", ms: 92 }] }),
      { keepalive: true },
    );
  });

  it("times send to acknowledgement", async () => {
    const result = await timeSendAck(async () => {
      now = 240;
      return "sent";
    });
    expect(result).toBe("sent");
    flushClientTiming();
    expect(mocks.record.mock.calls[0]?.[0].samples).toEqual([
      { kind: "send-ack", ms: 240 },
    ]);
  });

  it("measures stream lag from the latest apply, at most once a second", () => {
    markThreadViewed("thr_a");
    markThreadViewed("thr_b");
    noteStreamApplied("thr_a");
    now = 10;
    noteStreamApplied("thr_a");
    now = 45;
    noteStreamCommitted("thr_a");
    now = 50;
    noteStreamCommitted("thr_a");
    noteStreamApplied("thr_a");
    now = 300;
    noteStreamCommitted("thr_a");
    noteStreamApplied("thr_b");
    now = 61_500;
    noteStreamCommitted("thr_b");
    noteStreamApplied("thr_a");
    now = 61_520;
    noteStreamCommitted("thr_a");
    flushClientTiming();
    expect(mocks.record.mock.calls[0]?.[0].samples).toEqual([
      { kind: "stream-lag", ms: 35 },
      { kind: "stream-lag", ms: 20 },
    ]);
  });

  it("keeps at most 32 pending stream applies and drops stale ones", () => {
    for (let index = 0; index < 40; index += 1) {
      markThreadViewed(`thr_${index}`);
      noteStreamApplied(`thr_${index}`);
    }
    expect(streamAppliedCountForTests()).toBe(32);
    now = 60_001;
    markThreadViewed("thr_new");
    noteStreamApplied("thr_new");
    expect(streamAppliedCountForTests()).toBe(1);
  });

  it("ignores applies while hidden and does not count background time on return", () => {
    installClientTiming();
    markThreadViewed("thr_a");
    noteStreamApplied("thr_a");
    mocks.visible = false;
    for (const listener of mocks.visibility) listener();
    now = 100;
    noteStreamApplied("thr_a");
    expect(streamAppliedCountForTests()).toBe(0);
    now = 5_000;
    mocks.visible = true;
    for (const listener of mocks.visibility) listener();
    noteStreamCommitted("thr_a");
    flushClientTiming();
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it("ignores applies for threads not in view and forgets them when the view leaves", () => {
    noteStreamApplied("thr_a");
    expect(streamAppliedCountForTests()).toBe(0);
    const leaveFirst = markThreadViewed("thr_a");
    const leaveSecond = markThreadViewed("thr_a");
    noteStreamApplied("thr_a");
    leaveFirst();
    leaveFirst();
    expect(streamAppliedCountForTests()).toBe(1);
    leaveSecond();
    expect(streamAppliedCountForTests()).toBe(0);
    now = 20_000;
    markThreadViewed("thr_a");
    noteStreamCommitted("thr_a");
    flushClientTiming();
    expect(mocks.record).not.toHaveBeenCalled();
  });
});
