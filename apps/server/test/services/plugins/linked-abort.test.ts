import { getEventListeners } from "node:events";
import { describe, expect, it } from "vitest";
import { linkAbortSignals } from "../../../src/services/plugins/linked-abort.js";

describe("linkAbortSignals", () => {
  it("aborts when the caller aborts, with the caller's reason", () => {
    const caller = new AbortController();
    const lifetime = new AbortController();
    const linked = linkAbortSignals(caller.signal, lifetime.signal);
    expect(linked.signal.aborted).toBe(false);
    caller.abort(new Error("caller"));
    expect(linked.signal.aborted).toBe(true);
    expect((linked.signal.reason as Error).message).toBe("caller");
    expect(getEventListeners(lifetime.signal, "abort")).toHaveLength(0);
  });

  it("aborts when the plugin lifetime signal aborts", () => {
    const caller = new AbortController();
    const lifetime = new AbortController();
    const linked = linkAbortSignals(caller.signal, lifetime.signal);
    lifetime.abort(new Error("stopping"));
    expect(linked.signal.aborted).toBe(true);
    expect((linked.signal.reason as Error).message).toBe("stopping");
    expect(getEventListeners(caller.signal, "abort")).toHaveLength(0);
  });

  it("is aborted immediately when either source is already aborted", () => {
    const aborted = AbortSignal.abort(new Error("early"));
    const live = new AbortController();
    for (const [a, b] of [
      [aborted, live.signal],
      [live.signal, aborted],
    ] as const) {
      const linked = linkAbortSignals(a, b);
      expect(linked.signal.aborted).toBe(true);
      expect((linked.signal.reason as Error).message).toBe("early");
    }
    expect(getEventListeners(live.signal, "abort")).toHaveLength(0);
  });

  it("returns lifetime-signal listeners to baseline after many calls", () => {
    const lifetime = new AbortController();
    const baseline = getEventListeners(lifetime.signal, "abort").length;
    for (let i = 0; i < 5_000; i += 1) {
      const caller = new AbortController();
      const linked = linkAbortSignals(caller.signal, lifetime.signal);
      expect(getEventListeners(lifetime.signal, "abort")).toHaveLength(
        baseline + 1,
      );
      linked.dispose();
      linked.dispose();
      if (i % 2 === 0) caller.abort();
    }
    expect(getEventListeners(lifetime.signal, "abort")).toHaveLength(baseline);
  });
});
