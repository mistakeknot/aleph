import {
  createPaletteRenderer,
  DORCAS_PALETTES,
  hueArc,
  normalizeHue,
  redDistance,
  relativeLuminance,
  type DorcasModePalette,
  type PaletteRenderer,
} from "./dorcas-colors";

export const MOTION_MAX_GLOW = 0.4;
export const MOTION_DEAD_BAND = 0.005;
export const MOTION_EXTREME_TOLERANCE = 1e-4;
export const MOTION_MAX_REVERSALS = 4;
export const MOTION_WINDOW_MS = 1000;

export interface MotionValues {
  hue: number | null;
  glow: number;
}

export interface MotionCandidate extends MotionValues {
  ambientHue: number;
}

interface Sample {
  luminance: number;
  red: number;
}

interface TrackerState {
  direction: -1 | 0 | 1;
  extreme: number;
  leftExtremeMs: number | null;
}

interface TrackerStep {
  state: TrackerState;
  leaving: boolean;
  reversalAtMs: number | null;
}

class ReversalChannel {
  private state: TrackerState | null = null;
  private times: number[] = [];

  constructor(private readonly deadBand: number) {}

  private next(nowMs: number, value: number): TrackerStep {
    const fresh = { extreme: value, leftExtremeMs: null };
    const s = this.state;
    const quiet = { leaving: false, reversalAtMs: null };
    if (s === null) return { state: { direction: 0, ...fresh }, ...quiet };
    if (s.direction === 0) {
      if (Math.abs(value - s.extreme) <= this.deadBand) {
        return { state: s, ...quiet };
      }
      return {
        state: { direction: value > s.extreme ? 1 : -1, ...fresh },
        ...quiet,
      };
    }
    const along = (value - s.extreme) * s.direction;
    if (along > MOTION_EXTREME_TOLERANCE) {
      return { state: { direction: s.direction, ...fresh }, ...quiet };
    }
    if (along >= -MOTION_EXTREME_TOLERANCE) return { state: s, ...quiet };
    const leaving = s.leftExtremeMs === null;
    const leftExtremeMs = s.leftExtremeMs ?? nowMs;
    if (-along <= this.deadBand) {
      return { state: { ...s, leftExtremeMs }, leaving, reversalAtMs: null };
    }
    return {
      state: { direction: s.direction === 1 ? -1 : 1, ...fresh },
      leaving,
      reversalAtMs: leftExtremeMs,
    };
  }

  exceeds(nowMs: number, value: number, max: number): boolean {
    if (!this.next(nowMs, value).leaving) return false;
    return this.times.filter((t) => t > nowMs - MOTION_WINDOW_MS).length >= max;
  }

  commit(nowMs: number, value: number): void {
    const { state, reversalAtMs } = this.next(nowMs, value);
    this.state = state;
    if (reversalAtMs !== null) this.times.push(reversalAtMs);
    const earliestNext = state.leftExtremeMs ?? nowMs;
    this.times = this.times.filter((t) => t > earliestNext - MOTION_WINDOW_MS);
  }
}

interface ElementChannels {
  luminance: ReversalChannel;
  red: ReversalChannel;
}

export interface MotionGovernorOptions {
  palettes?: readonly DorcasModePalette[];
  deadBand?: number;
  maxReversals?: number;
}

export class MotionGovernor {
  private readonly renderers: PaletteRenderer[];
  private readonly channels = new Map<string, ElementChannels>();
  private readonly maxReversals: number;
  private readonly deadBand: number;
  private last: MotionValues | null = null;
  private lastRenderedHue: number | null = null;

  constructor(options: MotionGovernorOptions = {}) {
    this.renderers = (options.palettes ?? DORCAS_PALETTES).map((palette) =>
      createPaletteRenderer(palette),
    );
    this.deadBand = options.deadBand ?? MOTION_DEAD_BAND;
    this.maxReversals = options.maxReversals ?? MOTION_MAX_REVERSALS;
  }

  get current(): MotionValues | null {
    return this.last;
  }

  step(nowMs: number, candidate: MotionCandidate): MotionValues {
    const requested: MotionValues = {
      hue: candidate.hue === null ? null : normalizeHue(candidate.hue),
      glow: Math.min(MOTION_MAX_GLOW, Math.max(0, candidate.glow)),
    };
    const options = this.alternatives(requested, candidate.ambientHue);
    for (const option of options) {
      const samples = this.sample(option, candidate.ambientHue);
      if (this.withinBudget(nowMs, samples)) {
        return this.commit(nowMs, option, candidate.ambientHue, samples);
      }
    }
    const held = options[options.length - 1];
    return this.commit(
      nowMs,
      held,
      candidate.ambientHue,
      this.sample(held, candidate.ambientHue),
    );
  }

  private alternatives(
    requested: MotionValues,
    ambientHue: number,
  ): MotionValues[] {
    const last = this.last;
    if (last === null || this.lastRenderedHue === null) return [requested];
    const ambientUnchanged =
      Math.abs(hueArc(this.lastRenderedHue, normalizeHue(ambientHue))) < 1e-9;
    const heldHue =
      last.hue === null && ambientUnchanged ? null : this.lastRenderedHue;
    return [
      requested,
      { hue: heldHue, glow: requested.glow },
      { hue: requested.hue, glow: last.glow },
      { hue: heldHue, glow: last.glow },
    ];
  }

  private sample(
    values: MotionValues,
    ambientHue: number,
  ): Map<string, Sample> {
    const hue = values.hue ?? normalizeHue(ambientHue);
    const out = new Map<string, Sample>();
    for (const renderer of this.renderers) {
      let luminanceSum = 0;
      let redSum = 0;
      let primaryCount = 0;
      for (const element of renderer.render(hue, values.glow)) {
        const sample: Sample = {
          luminance: relativeLuminance(element.rgb),
          red: redDistance(element.rgb),
        };
        if (element.primary) {
          luminanceSum += sample.luminance;
          redSum += sample.red;
          primaryCount += 1;
        }
        out.set(`${renderer.mode}/${element.name}`, sample);
      }
      out.set(`${renderer.mode}/combined`, {
        luminance: luminanceSum / primaryCount,
        red: redSum / primaryCount,
      });
    }
    return out;
  }

  private channelFor(name: string): ElementChannels {
    let channels = this.channels.get(name);
    if (!channels) {
      channels = {
        luminance: new ReversalChannel(this.deadBand),
        red: new ReversalChannel(this.deadBand),
      };
      this.channels.set(name, channels);
    }
    return channels;
  }

  private withinBudget(nowMs: number, samples: Map<string, Sample>): boolean {
    for (const [name, sample] of samples) {
      const { luminance, red } = this.channelFor(name);
      if (
        luminance.exceeds(nowMs, sample.luminance, this.maxReversals) ||
        red.exceeds(nowMs, sample.red, this.maxReversals)
      ) {
        return false;
      }
    }
    return true;
  }

  private commit(
    nowMs: number,
    values: MotionValues,
    ambientHue: number,
    samples: Map<string, Sample>,
  ): MotionValues {
    for (const [name, sample] of samples) {
      const { luminance, red } = this.channelFor(name);
      luminance.commit(nowMs, sample.luminance);
      red.commit(nowMs, sample.red);
    }
    this.last = values;
    this.lastRenderedHue = values.hue ?? normalizeHue(ambientHue);
    return values;
  }
}
