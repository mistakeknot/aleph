import { describe, expect, it } from "vitest";
import {
  createRestartBackoff,
  DEFAULT_RESTART_POLICY,
  resolveRestartPolicy,
} from "../src/restart-policy.js";

describe("restart backoff", () => {
  it("doubles from one second up to the sixty second cap", () => {
    const backoff = createRestartBackoff({ policy: DEFAULT_RESTART_POLICY });
    const delays: number[] = [];
    for (let i = 0; i < 9; i += 1) {
      delays.push(backoff.recordFailure().delayMs);
    }
    expect(delays).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000, 60_000,
    ]);
  });

  it("gives up on the tenth consecutive failure by default", () => {
    const backoff = createRestartBackoff({ policy: DEFAULT_RESTART_POLICY });
    const exhausted: boolean[] = [];
    for (let i = 0; i < 10; i += 1) {
      exhausted.push(backoff.recordFailure().exhausted);
    }
    expect(exhausted.slice(0, 9).every((value) => !value)).toBe(true);
    expect(exhausted[9]).toBe(true);
  });

  it("starts over after the process stayed up for the stable window", () => {
    let nowMs = 0;
    const backoff = createRestartBackoff({
      now: () => nowMs,
      policy: DEFAULT_RESTART_POLICY,
    });
    backoff.recordFailure();
    backoff.recordFailure();
    backoff.recordFailure();
    backoff.recordHealthy();
    nowMs += DEFAULT_RESTART_POLICY.stableUptimeMs;
    expect(backoff.recordFailure()).toEqual({
      consecutiveFailures: 1,
      delayMs: 1_000,
      exhausted: false,
    });
  });

  it("keeps the streak when the process died before the stable window", () => {
    let nowMs = 0;
    const backoff = createRestartBackoff({
      now: () => nowMs,
      policy: DEFAULT_RESTART_POLICY,
    });
    backoff.recordFailure();
    backoff.recordHealthy();
    nowMs += DEFAULT_RESTART_POLICY.stableUptimeMs - 1;
    expect(backoff.recordFailure().consecutiveFailures).toBe(2);
  });

  it("never exceeds the cap even for a long streak", () => {
    const backoff = createRestartBackoff({
      policy: { ...DEFAULT_RESTART_POLICY, maxConsecutiveFailures: 1_000 },
    });
    let last = 0;
    for (let i = 0; i < 200; i += 1) {
      last = backoff.recordFailure().delayMs;
    }
    expect(last).toBe(60_000);
  });
});

describe("resolveRestartPolicy", () => {
  it("returns the defaults when nothing is set", () => {
    expect(resolveRestartPolicy({})).toEqual(DEFAULT_RESTART_POLICY);
  });

  it("reads overrides and ignores values that are not positive integers", () => {
    expect(
      resolveRestartPolicy({
        BB_APP_RESTART_MAX_DELAY_MS: "5000",
        BB_APP_RESTART_MAX_FAILURES: "3",
        BB_APP_RESTART_STABLE_UPTIME_MS: "1000",
      }),
    ).toEqual({
      initialDelayMs: 1_000,
      maxConsecutiveFailures: 3,
      maxDelayMs: 5_000,
      stableUptimeMs: 1_000,
    });
    expect(
      resolveRestartPolicy({
        BB_APP_RESTART_MAX_DELAY_MS: "0",
        BB_APP_RESTART_MAX_FAILURES: "abc",
        BB_APP_RESTART_STABLE_UPTIME_MS: "-5",
      }),
    ).toEqual(DEFAULT_RESTART_POLICY);
  });

  it("never lets the first delay exceed the cap", () => {
    expect(
      resolveRestartPolicy({ BB_APP_RESTART_MAX_DELAY_MS: "200" }),
    ).toMatchObject({ initialDelayMs: 200, maxDelayMs: 200 });
  });
});
