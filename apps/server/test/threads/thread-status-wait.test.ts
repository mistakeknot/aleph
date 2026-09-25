import { describe, expect, it } from "vitest";
import {
  isThreadStatusWaitUnreachable,
  resolveThreadStatusWaitOutcome,
} from "../../src/services/threads/thread-status-wait.js";

describe("resolveThreadStatusWaitOutcome", () => {
  it("matches once the current status equals the target", () => {
    expect(
      resolveThreadStatusWaitOutcome({ current: "idle", target: "idle" }),
    ).toBe("matched");
    expect(
      resolveThreadStatusWaitOutcome({ current: "active", target: "active" }),
    ).toBe("matched");
  });

  it("stays pending while the thread is still moving toward the target", () => {
    expect(
      resolveThreadStatusWaitOutcome({ current: "starting", target: "idle" }),
    ).toBe("pending");
    expect(
      resolveThreadStatusWaitOutcome({ current: "active", target: "idle" }),
    ).toBe("pending");
    expect(
      resolveThreadStatusWaitOutcome({ current: "stopping", target: "idle" }),
    ).toBe("pending");
  });

  it("is unreachable when waiting for idle but the thread has errored", () => {
    expect(
      resolveThreadStatusWaitOutcome({ current: "error", target: "idle" }),
    ).toBe("unreachable");
  });

  it("does not treat error as unreachable for a non-idle target", () => {
    expect(
      resolveThreadStatusWaitOutcome({ current: "error", target: "error" }),
    ).toBe("matched");
    expect(
      resolveThreadStatusWaitOutcome({ current: "error", target: "active" }),
    ).toBe("pending");
  });
});

describe("isThreadStatusWaitUnreachable", () => {
  it("is true only for an errored thread targeting idle", () => {
    expect(
      isThreadStatusWaitUnreachable({ current: "error", target: "idle" }),
    ).toBe(true);
    expect(
      isThreadStatusWaitUnreachable({ current: "idle", target: "idle" }),
    ).toBe(false);
    expect(
      isThreadStatusWaitUnreachable({ current: "error", target: "active" }),
    ).toBe(false);
  });
});
