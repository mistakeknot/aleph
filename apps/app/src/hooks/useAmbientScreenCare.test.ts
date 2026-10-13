// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AMBIENT_DRIFT_PERIOD_MS,
  AMBIENT_IDLE_AFTER_MS,
  AMBIENT_IDLE_ATTRIBUTE,
  AMBIENT_REST_AFTER_MS,
  AMBIENT_REST_ATTRIBUTE,
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

function isResting(): boolean {
  return document.documentElement.hasAttribute(AMBIENT_REST_ATTRIBUTE);
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
  vi.restoreAllMocks();
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
  it("keeps windows opened at different moments on the same step", () => {
    installReducedMotion(false);
    vi.setSystemTime(3 * AMBIENT_TICK_MS + AMBIENT_TICK_MS / 2);
    const stop = startAmbientScreenCare();
    const opened = wave();
    vi.advanceTimersByTime(AMBIENT_TICK_MS / 2 - 1);
    expect(wave()).toBe(opened);
    vi.advanceTimersByTime(1);
    expect(wave()).toBe(String(ambientWave(Date.now())));
    expect(Date.now() % AMBIENT_TICK_MS).toBe(0);
    stop();
  });

  it("treats a focused or hovered embedded frame as activity", () => {
    installReducedMotion(false);
    const frame = document.createElement("iframe");
    document.body.append(frame);
    frame.focus();
    const stop = startAmbientScreenCare();
    vi.advanceTimersByTime(AMBIENT_IDLE_AFTER_MS * 2);
    expect(isIdle()).toBe(false);

    frame.blur();
    frame.remove();
    vi.advanceTimersByTime(AMBIENT_IDLE_AFTER_MS);
    expect(isIdle()).toBe(true);
    stop();
  });

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

  it("rests the chrome after a quiet minute and wakes it on input", () => {
    installReducedMotion(false);
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const stop = startAmbientScreenCare();
    expect(isResting()).toBe(false);

    vi.advanceTimersByTime(AMBIENT_REST_AFTER_MS - AMBIENT_TICK_MS);
    expect(isResting()).toBe(false);
    vi.advanceTimersByTime(AMBIENT_TICK_MS);
    expect(isResting()).toBe(true);
    expect(isIdle()).toBe(false);

    window.dispatchEvent(new Event("pointerdown"));
    expect(isResting()).toBe(false);
    stop();
  });

  it("rests the chrome while the window is in the background", () => {
    installReducedMotion(false);
    const focus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const stop = startAmbientScreenCare();

    focus.mockReturnValue(false);
    window.dispatchEvent(new Event("blur"));
    vi.advanceTimersByTime(0);
    expect(isResting()).toBe(true);

    focus.mockReturnValue(true);
    window.dispatchEvent(new Event("focus"));
    vi.advanceTimersByTime(0);
    expect(isResting()).toBe(false);

    stop();
    expect(isResting()).toBe(false);
  });

  it("rests exactly a minute after the last input, between ticks", () => {
    installReducedMotion(false);
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    vi.setSystemTime(1);
    const stop = startAmbientScreenCare();

    vi.advanceTimersByTime(AMBIENT_TICK_MS / 3);
    window.dispatchEvent(new Event("keydown"));
    vi.advanceTimersByTime(AMBIENT_REST_AFTER_MS - 1);
    expect(isResting()).toBe(false);
    vi.advanceTimersByTime(1);
    expect(isResting()).toBe(true);
    stop();
  });
});
