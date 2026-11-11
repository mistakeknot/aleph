import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  cancelAndAwaitDeferredWorkForTesting,
  deferAfterResponse,
  enableDeferredWorkTrackingForTesting,
  trackDeferredTimer,
} from "../../src/services/lib/response-deferral.js";
import { withTestHarness } from "./test-app.js";

const LOGGER = { warn: () => undefined };
const CONFIG = { isDevelopment: false };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("test harness teardown of deferred work", () => {
  beforeAll(() => {
    enableDeferredWorkTrackingForTesting();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("awaits deferred work already in flight", async () => {
    let finished = false;
    await withTestHarness(async () => {
      deferAfterResponse({
        config: CONFIG,
        logger: LOGGER,
        name: "in-flight",
        work: async () => {
          await sleep(60);
          finished = true;
        },
      });
      await new Promise((resolve) => setImmediate(resolve));
      expect(finished).toBe(false);
    });
    expect(finished).toBe(true);
  });

  it("cancels deferred work that has not started", async () => {
    let started = false;
    await withTestHarness(async () => {
      deferAfterResponse({
        config: CONFIG,
        logger: LOGGER,
        name: "pending",
        work: async () => {
          started = true;
        },
      });
    });
    await sleep(20);
    expect(started).toBe(false);
  });

  it("cancels deferred work scheduled by in-flight work", async () => {
    let followUpStarted = false;
    await withTestHarness(async () => {
      deferAfterResponse({
        config: CONFIG,
        logger: LOGGER,
        name: "parent",
        work: async () => {
          await sleep(30);
          deferAfterResponse({
            config: CONFIG,
            logger: LOGGER,
            name: "follow-up",
            work: async () => {
              followUpStarted = true;
            },
          });
        },
      });
      await new Promise((resolve) => setImmediate(resolve));
    });
    await sleep(20);
    expect(followUpStarted).toBe(false);
  });

  it("clears tracked timers", async () => {
    let fired = false;
    trackDeferredTimer(
      setTimeout(() => {
        fired = true;
      }, 30),
    );
    await cancelAndAwaitDeferredWorkForTesting();
    await sleep(80);
    expect(fired).toBe(false);
  });

  it("does not wait on in-flight work while fake timers are active", async () => {
    let settled = false;
    await withTestHarness(async () => {
      vi.useFakeTimers();
      deferAfterResponse({
        config: CONFIG,
        logger: LOGGER,
        name: "stuck on fake timer",
        work: async () => {
          await new Promise((resolve) => setTimeout(resolve, 60));
          settled = true;
        },
      });
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(settled).toBe(false);
  });

  it("does not wait on work stuck behind a discarded fake timer", async () => {
    let settled = false;
    const outcome = await Promise.race([
      withTestHarness(async () => {
        vi.useFakeTimers();
        deferAfterResponse({
          config: CONFIG,
          logger: LOGGER,
          name: "discarded fake timer",
          work: async () => {
            await new Promise((resolve) => setTimeout(resolve, 60));
            settled = true;
          },
        });
        await vi.advanceTimersByTimeAsync(0);
        vi.useRealTimers();
      }).then(() => "completed"),
      sleep(500).then(() => "hung"),
    ]);
    expect(outcome).toBe("completed");
    expect(settled).toBe(false);
  });

  it("does not wait on abandoned fake-timer work in a later real-timer cleanup", async () => {
    await withTestHarness(async () => {
      vi.useFakeTimers();
      deferAfterResponse({
        config: CONFIG,
        logger: LOGGER,
        name: "abandoned on fake timer",
        work: async () => {
          await new Promise((resolve) => setTimeout(resolve, 60));
        },
      });
      await vi.advanceTimersByTimeAsync(0);
    });
    vi.useRealTimers();
    const outcome = await Promise.race([
      cancelAndAwaitDeferredWorkForTesting().then(() => "completed"),
      sleep(500).then(() => "hung"),
    ]);
    expect(outcome).toBe("completed");
  });

  it("still awaits live work when only Date is faked", async () => {
    let finished = false;
    await withTestHarness(async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      deferAfterResponse({
        config: CONFIG,
        logger: LOGGER,
        name: "date-only fake",
        work: async () => {
          await sleep(60);
          finished = true;
        },
      });
      await new Promise((resolve) => setImmediate(resolve));
      expect(finished).toBe(false);
    });
    expect(finished).toBe(true);
  });

  it("leaves deferred work untouched until tracking is enabled", async () => {
    vi.resetModules();
    const fresh = await import("../../src/services/lib/response-deferral.js");
    let ran = false;
    fresh.deferAfterResponse({
      config: CONFIG,
      logger: LOGGER,
      name: "untracked",
      work: async () => {
        ran = true;
      },
    });
    await fresh.cancelAndAwaitDeferredWorkForTesting();
    await sleep(20);
    expect(ran).toBe(true);
  });
});
