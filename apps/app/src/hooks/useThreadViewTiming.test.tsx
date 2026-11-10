// @vitest-environment jsdom
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  record: vi.fn(),
  viewed: [] as string[],
  hidden: 0,
  visible: true,
}));

vi.mock("../lib/client-timing", () => ({
  clientTimingHiddenCount: () => mocks.hidden,
  markThreadViewed: (threadId: string) => {
    mocks.viewed.push(`+${threadId}`);
    return () => mocks.viewed.push(`-${threadId}`);
  },
  recordClientTiming: mocks.record,
}));
vi.mock("../lib/document-visibility", () => ({
  isDocumentVisible: () => mocks.visible,
}));

const { useThreadViewTiming } = await import("./useThreadViewTiming");

let now = 0;
let frames = new Map<number, FrameRequestCallback>();
let nextFrame = 0;

function runFrames(at: number) {
  now = at;
  const pending = [...frames.values()];
  frames.clear();
  for (const frame of pending) frame(at);
}

beforeEach(() => {
  now = 0;
  frames = new Map();
  mocks.record.mockReset();
  mocks.viewed = [];
  mocks.hidden = 0;
  mocks.visible = true;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    nextFrame += 1;
    frames.set(nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    frames.delete(id);
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("useThreadViewTiming", () => {
  it("records once from mount to the first frame after the timeline is ready", () => {
    const { rerender } = renderHook(
      ({ threadId, ready }) => useThreadViewTiming(threadId, ready),
      { initialProps: { threadId: "thr_a", ready: false } },
    );
    now = 300;
    rerender({ threadId: "thr_a", ready: true });
    runFrames(320);
    rerender({ threadId: "thr_a", ready: true });
    runFrames(400);
    expect(mocks.record.mock.calls).toEqual([["thread-view", 320, false]]);
  });

  it("starts again when the same mount switches threads and marks a ready timeline cached", () => {
    const { rerender } = renderHook(
      ({ threadId, ready }) => useThreadViewTiming(threadId, ready),
      { initialProps: { threadId: "thr_a", ready: true } },
    );
    runFrames(16);
    now = 1_000;
    rerender({ threadId: "thr_b", ready: true });
    runFrames(1_016);
    expect(mocks.record.mock.calls).toEqual([
      ["thread-view", 16, true],
      ["thread-view", 16, true],
    ]);
  });

  it("skips a load that started hidden or was hidden before the first frame", () => {
    mocks.visible = false;
    const first = renderHook(() => useThreadViewTiming("thr_a", true));
    runFrames(16);
    first.unmount();
    mocks.visible = true;
    const { rerender } = renderHook(
      ({ ready }) => useThreadViewTiming("thr_b", ready),
      { initialProps: { ready: false } },
    );
    mocks.hidden = 1;
    rerender({ ready: true });
    runFrames(5_000);
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it("marks the shown thread as viewed and releases it on switch and unmount", () => {
    const { rerender, unmount } = renderHook(
      ({ threadId }) => useThreadViewTiming(threadId, false),
      { initialProps: { threadId: "thr_a" } },
    );
    rerender({ threadId: "thr_b" });
    unmount();
    expect(mocks.viewed).toEqual(["+thr_a", "-thr_a", "+thr_b", "-thr_b"]);
  });
});
