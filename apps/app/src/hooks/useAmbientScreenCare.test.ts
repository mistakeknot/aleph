// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AMBIENT_DRIFT_PERIOD_MS,
  AMBIENT_IDLE_AFTER_MS,
  AMBIENT_IDLE_ATTRIBUTE,
  AMBIENT_TICK_MS,
  AMBIENT_WAVE_PROPERTY,
  ambientWave,
  startAmbientScreenCare,
} from "./useAmbientScreenCare";

function installReducedMotion(initial: boolean): {
  set(reduced: boolean): void;
} {
  let reduced = initial;
  const listeners = new Set<() => void>();
  const query = {
    get matches() {
      return reduced;
    },
    media: "(prefers-reduced-motion: reduce)",
    addEventListener(_type: string, listener: () => void) {
      listeners.add(listener);
    },
    removeEventListener(_type: string, listener: () => void) {
      listeners.delete(listener);
    },
  } as unknown as MediaQueryList;
  window.matchMedia = vi.fn(() => query);
  return {
    set(next) {
      reduced = next;
      for (const listener of listeners) listener();
    },
  };
}

function wave(): string {
  return document.documentElement.style.getPropertyValue(AMBIENT_WAVE_PROPERTY);
}

function isIdle(): boolean {
  return document.documentElement.hasAttribute(AMBIENT_IDLE_ATTRIBUTE);
}

const originalMatchMedia = window.matchMedia;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});

afterEach(() => {
  vi.useRealTimers();
  window.matchMedia = originalMatchMedia;
});

describe("ambientWave", () => {
  it("rises from rose to cyan and falls back over one period", () => {
    expect(ambientWave(0)).toBe(0);
    expect(ambientWave(AMBIENT_DRIFT_PERIOD_MS / 4)).toBe(0.5);
    expect(ambientWave(AMBIENT_DRIFT_PERIOD_MS / 2)).toBe(1);
    expect(ambientWave((AMBIENT_DRIFT_PERIOD_MS * 3) / 4)).toBe(0.5);
    expect(ambientWave(AMBIENT_DRIFT_PERIOD_MS)).toBe(0);
  });

  it("gives every window the same value at the same moment", () => {
    const at = 7 * AMBIENT_DRIFT_PERIOD_MS + 123_456;
    expect(ambientWave(at)).toBe(ambientWave(123_456));
  });
});

describe("startAmbientScreenCare", () => {
  it("steps the drift on each tick and clears it on stop", () => {
    installReducedMotion(false);
    const stop = startAmbientScreenCare();
    expect(wave()).toBe("0");

    vi.advanceTimersByTime(AMBIENT_DRIFT_PERIOD_MS / 4);
    expect(wave()).toBe("0.5");

    stop();
    expect(wave()).toBe("");
  });

  it("holds the drift still under reduced motion and resumes when it is lifted", () => {
    const motion = installReducedMotion(true);
    const stop = startAmbientScreenCare();
    vi.advanceTimersByTime(AMBIENT_DRIFT_PERIOD_MS / 4);
    expect(wave()).toBe("");

    motion.set(false);
    expect(wave()).toBe("0.5");
    stop();
  });

  it("dims after the idle timeout and wakes on input", () => {
    installReducedMotion(false);
    const stop = startAmbientScreenCare();

    vi.advanceTimersByTime(AMBIENT_IDLE_AFTER_MS - AMBIENT_TICK_MS);
    expect(isIdle()).toBe(false);
    vi.advanceTimersByTime(AMBIENT_TICK_MS);
    expect(isIdle()).toBe(true);

    window.dispatchEvent(new Event("keydown"));
    expect(isIdle()).toBe(false);

    vi.advanceTimersByTime(AMBIENT_IDLE_AFTER_MS);
    expect(isIdle()).toBe(true);
    stop();
    expect(isIdle()).toBe(false);
  });

  it("stays awake while input keeps arriving", () => {
    installReducedMotion(false);
    const stop = startAmbientScreenCare();
    for (let elapsed = 0; elapsed < AMBIENT_IDLE_AFTER_MS * 2;) {
      vi.advanceTimersByTime(AMBIENT_TICK_MS);
      elapsed += AMBIENT_TICK_MS;
      window.dispatchEvent(new Event("pointermove"));
    }
    expect(isIdle()).toBe(false);
    stop();
  });
});
