import { hueArc, normalizeHue } from "./dorcas-colors";
import {
  MOTION_MAX_GLOW,
  MotionGovernor,
  type MotionValues,
} from "./motion-governor";
import type { SignalFields, SignalKeyMode } from "./signal-schema";

export const MUSIC_FRESH_MS = 1500;
export const MUSIC_FADE_MS = 2000;
export const MUSIC_MAX_TICK_MS = 100;
export const MUSIC_SHEET_SETTLE_MS = 1000;
export const PULSE_RISE_MS = 90;
export const PULSE_DECAY_MS = 450;
export const PULSE_WINDOW_MS = 1000;
export const PULSE_MAX_PER_WINDOW = 2;
export const ENERGY_TAU_MS = 1500;
export const REST_GLOW_MAX = 0.12;
export const PULSE_GLOW_GAIN = 0.28;
export const KEY_ENGAGE_CONFIDENCE = 0.55;
export const KEY_RELEASE_CONFIDENCE = 0.4;
export const KEY_RELEASE_AFTER_MS = 3000;
export const HUE_EASE_MS = 2000;
export const HUE_RELEASE_EASE_MS = 4000;
export const HUE_WRITE_INTERVAL_MS = 250;
export const HUE_MIN_STEP_DEGREES = 0.5;
export const GLOW_STEP = 0.005;

const ENERGY_FLOOR = 0.005;

export function keyHue(key: number, mode: SignalKeyMode): number {
  return normalizeHue(350 + 30 * key - (mode === "minor" ? 15 : 0));
}

export function ambientHueFor(wave: number): number {
  return normalizeHue(350 - 125 * wave);
}

const smooth = (x: number): number => x * x * (3 - 2 * x);
const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));

interface HueEase {
  from: number | null;
  to: number | null;
  startMs: number;
  durationMs: number;
}

export interface MusicMotionFrame extends MotionValues {
  settled: boolean;
}

export class MusicMotion {
  private readonly governor: MotionGovernor;
  private active = false;
  private suppressed = false;
  private rest = false;
  private dorcasSheet = true;
  private sheetSinceMs: number | null = -Infinity;
  private glowGate = 1;
  private lastTickMs: number | null = null;
  private lastFreshMs: number | null = null;
  private latestEnergy = 0;
  private energy = 0;
  private strength = 0;
  private acceptedBeats: number[] = [];
  private pulseStartMs: number | null = null;
  private pulseFrom = 0;
  private engaged = false;
  private target: number | null = null;
  private lowSinceMs: number | null = null;
  private ease: HueEase = { from: null, to: null, startMs: 0, durationMs: 0 };
  private lastHueWriteMs = -Infinity;
  private output: MotionValues = { hue: null, glow: 0 };

  constructor(governor: MotionGovernor = new MotionGovernor()) {
    this.governor = governor;
  }

  setActive(active: boolean): void {
    this.active = active;
    if (!active) this.lastFreshMs = null;
  }

  setSuppressed(suppressed: boolean): void {
    this.suppressed = suppressed;
  }

  setRest(rest: boolean): void {
    this.rest = rest;
  }

  setDorcasSheet(shown: boolean): void {
    if (shown === this.dorcasSheet) return;
    this.dorcasSheet = shown;
    this.sheetSinceMs = null;
    if (!shown) this.glowGate = 0;
  }

  receive(nowMs: number, fields: SignalFields): void {
    if (!this.active || this.suppressed || fields.synthetic) return;
    this.lastFreshMs = nowMs;
    this.latestEnergy = fields.energy;
    if (fields.beat) this.acceptBeat(nowMs);
    if (fields.keyConfidence >= KEY_ENGAGE_CONFIDENCE) {
      this.engaged = true;
      this.target = keyHue(fields.key, fields.keyMode);
      this.lowSinceMs = null;
    } else if (fields.keyConfidence < KEY_RELEASE_CONFIDENCE) {
      this.lowSinceMs ??= nowMs;
    } else {
      this.lowSinceMs = null;
    }
  }

  private acceptBeat(nowMs: number): void {
    this.acceptedBeats = this.acceptedBeats.filter(
      (at) => at > nowMs - PULSE_WINDOW_MS,
    );
    if (this.acceptedBeats.length >= PULSE_MAX_PER_WINDOW) return;
    if (
      this.pulseStartMs !== null &&
      nowMs - this.pulseStartMs < PULSE_RISE_MS
    ) {
      return;
    }
    this.pulseFrom = this.pulse(nowMs);
    this.pulseStartMs = nowMs;
    this.acceptedBeats.push(nowMs);
  }

  pulse(nowMs: number): number {
    if (this.pulseStartMs === null) return 0;
    const elapsed = nowMs - this.pulseStartMs;
    if (elapsed < PULSE_RISE_MS) {
      return this.pulseFrom + (1 - this.pulseFrom) * (elapsed / PULSE_RISE_MS);
    }
    const x = (elapsed - PULSE_RISE_MS) / PULSE_DECAY_MS;
    return x >= 1 ? 0 : (1 - x) ** 2;
  }

  private fresh(nowMs: number): boolean {
    return (
      this.active &&
      !this.suppressed &&
      this.lastFreshMs !== null &&
      nowMs - this.lastFreshMs <= MUSIC_FRESH_MS
    );
  }

  private hueAt(nowMs: number, ambientHue: number): number | null {
    const resolve = (h: number | null) => h ?? ambientHue;
    const { from, to, startMs, durationMs } = this.ease;
    const s = durationMs > 0 ? clamp01((nowMs - startMs) / durationMs) : 1;
    if (s >= 1) return to;
    const start = resolve(from);
    return normalizeHue(start + hueArc(start, resolve(to)) * smooth(s));
  }

  private advanceHue(nowMs: number, ambientHue: number): number | null {
    if (
      this.engaged &&
      this.lowSinceMs !== null &&
      nowMs - this.lowSinceMs >= KEY_RELEASE_AFTER_MS
    ) {
      this.engaged = false;
      this.target = null;
    }
    const { to, startMs, durationMs } = this.ease;
    const finished = nowMs - startMs >= durationMs;
    if (finished && this.target !== to) {
      this.ease = {
        from: to,
        to: this.target,
        startMs: nowMs,
        durationMs: this.target === null ? HUE_RELEASE_EASE_MS : HUE_EASE_MS,
      };
    }
    return this.hueAt(nowMs, ambientHue);
  }

  private resetMusicState(): void {
    this.engaged = false;
    this.target = null;
    this.lowSinceMs = null;
    this.ease = { from: null, to: null, startMs: 0, durationMs: 0 };
    this.energy = 0;
    this.latestEnergy = 0;
    this.pulseStartMs = null;
    this.pulseFrom = 0;
    this.acceptedBeats = [];
  }

  tick(nowMs: number, ambientHue: number): MusicMotionFrame {
    const dt =
      this.lastTickMs === null
        ? 0
        : Math.min(MUSIC_MAX_TICK_MS, Math.max(0, nowMs - this.lastTickMs));
    this.lastTickMs = nowMs;
    const fresh = this.fresh(nowMs);

    const step = dt / MUSIC_FADE_MS;
    this.strength = fresh
      ? Math.min(1, this.strength + step)
      : Math.max(0, this.strength - step);
    this.advanceGlowGate(nowMs, step);
    if (this.strength === 0 && !fresh) this.resetMusicState();

    const energyInput = fresh ? this.latestEnergy : 0;
    this.energy +=
      (energyInput - this.energy) * (1 - Math.exp(-dt / ENERGY_TAU_MS));
    if (this.energy < ENERGY_FLOOR && energyInput === 0) this.energy = 0;

    const musicHue = this.advanceHue(nowMs, ambientHue);
    const m = smooth(this.strength);
    let hue: number | null = null;
    if (m > 0 && musicHue !== null) {
      hue = normalizeHue(ambientHue + hueArc(ambientHue, musicHue) * m);
    }

    const glowRaw = this.rest
      ? 0
      : Math.min(
          MOTION_MAX_GLOW,
          REST_GLOW_MAX * this.energy + PULSE_GLOW_GAIN * this.pulse(nowMs),
        ) *
        m *
        smooth(this.glowGate);
    const glow = Math.round(glowRaw / GLOW_STEP) * GLOW_STEP;

    const candidateHue = this.limitHue(nowMs, hue, ambientHue);
    const previousHue = this.output.hue;
    this.output = this.governor.step(nowMs, {
      hue: candidateHue,
      glow,
      ambientHue,
      glowShown: this.dorcasSheet,
      reserveGlowDrop: this.glowGate < 1,
    });
    if (this.output.hue !== previousHue) this.lastHueWriteMs = nowMs;

    const settled =
      this.output.hue === null &&
      this.output.glow === 0 &&
      this.strength === 0 &&
      !fresh;
    return { ...this.output, settled };
  }

  private advanceGlowGate(nowMs: number, step: number): void {
    if (!this.dorcasSheet) {
      this.glowGate = 0;
      return;
    }
    this.sheetSinceMs ??= nowMs;
    if (nowMs - this.sheetSinceMs >= MUSIC_SHEET_SETTLE_MS) {
      this.glowGate = Math.min(1, this.glowGate + step);
    }
  }

  private limitHue(
    nowMs: number,
    hue: number | null,
    ambientHue: number,
  ): number | null {
    const previous = this.output.hue;
    if (hue === previous) return hue;
    if (nowMs - this.lastHueWriteMs < HUE_WRITE_INTERVAL_MS) return previous;
    const near = (a: number, b: number) =>
      Math.abs(hueArc(a, b)) < HUE_MIN_STEP_DEGREES;
    if (previous === null) {
      return hue !== null && near(ambientHue, hue) ? null : hue;
    }
    if (hue === null) return near(previous, ambientHue) ? null : ambientHue;
    return near(previous, hue) ? previous : hue;
  }
}
