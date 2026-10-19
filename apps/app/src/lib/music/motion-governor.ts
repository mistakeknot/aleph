import {
  composite,
  DORCAS_PALETTES,
  hexToRgb,
  hueArc,
  isSaturatedRed,
  mixInOklch,
  normalizeHue,
  oklchToRgb,
  relativeLuminance,
  type DorcasModePalette,
  type HueToken,
  type Rgb,
} from "./dorcas-colors";

export const MOTION_MAX_GLOW = 0.4;
export const MOTION_DEAD_BAND = 0.005;
export const MOTION_EXTREME_TOLERANCE = 1e-4;
export const MOTION_MAX_REVERSALS = 4;
export const MOTION_WINDOW_MS = 1000;

export const MOTION_FRACTION_RATIO = 1.05;
export const MOTION_RANGE_MARGIN = 1.5;
export const RED_CAPABLE_RATIO = 0.7;

const RANGE_HUE_STEP = 1;
const RANGE_OPACITY_SAMPLES = 9;
const RED_SCAN_HUE_STEP = 0.5;
const RED_SCAN_OPACITIES = 17;

export interface MotionValues {
  hue: number | null;
  glow: number;
}

export interface MotionCandidate extends MotionValues {
  ambientHue: number;
  glowShown: boolean;
  reserveGlowDrop: boolean;
}

interface Surface {
  source: string;
  glow: boolean;
  token: HueToken;
  background: Rgb;
  fractions: readonly number[];
  keys: readonly string[];
}

interface ModeModel {
  mode: DorcasModePalette["mode"];
  sources: { name: string; token: HueToken }[];
  surfaces: Surface[];
}

function backgroundsOf(palette: DorcasModePalette): [string, Rgb][] {
  const canvas = hexToRgb(palette.canvas);
  return [
    ["canvas", canvas],
    [
      "sidebar",
      mixInOklch(hexToRgb(palette.ink), palette.sidebarInkPercent, canvas),
    ],
  ];
}

function sourcesOf(
  palette: DorcasModePalette,
): { name: string; glow: boolean; token: HueToken }[] {
  return [
    { name: "glow", glow: true, token: palette.glow },
    ...Object.entries(palette.hueTokens).map(([name, token]) => ({
      name,
      glow: false,
      token,
    })),
  ];
}

const sourceRgb = (token: HueToken, hue: number): Rgb =>
  oklchToRgb({ l: token.l, c: token.c, h: hue });

const maxOpacity = (glow: boolean, token: HueToken): number =>
  token.alpha * (glow ? MOTION_MAX_GLOW : 1);

function luminanceRange(
  token: HueToken,
  background: Rgb,
  glow: boolean,
  fraction: number,
): number {
  const opacityMax = maxOpacity(glow, token) * fraction;
  const opacities = glow
    ? Array.from(
        { length: RANGE_OPACITY_SAMPLES },
        (_, k) => (opacityMax * k) / (RANGE_OPACITY_SAMPLES - 1),
      )
    : [opacityMax];
  let low = Infinity;
  let high = -Infinity;
  for (let hue = 0; hue < 360; hue += RANGE_HUE_STEP) {
    const color = sourceRgb(token, hue);
    for (const opacity of opacities) {
      const y = relativeLuminance(composite(color, opacity, background));
      low = Math.min(low, y);
      high = Math.max(high, y);
    }
  }
  return high - low;
}

export function motionTrackedFractions(
  token: HueToken,
  background: Rgb,
  glow: boolean,
): number[] {
  const fractions: number[] = [];
  for (let fraction = 1; ; fraction /= MOTION_FRACTION_RATIO) {
    const range = luminanceRange(token, background, glow, fraction);
    if (range * MOTION_RANGE_MARGIN < MOTION_DEAD_BAND) return fractions;
    fractions.push(fraction);
  }
}

export function redCapablePalette(palette: DorcasModePalette): boolean {
  const ratio = (r: number, g: number, b: number) =>
    r + g + b > 0 ? r / (r + g + b) : 0;
  const linear = (c: number) =>
    c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  for (const [, background] of backgroundsOf(palette)) {
    for (const { glow, token } of sourcesOf(palette)) {
      const opacityMax = maxOpacity(glow, token);
      for (let hue = 0; hue < 360; hue += RED_SCAN_HUE_STEP) {
        const color = sourceRgb(token, hue);
        for (let k = 0; k < RED_SCAN_OPACITIES; k++) {
          const rgb = composite(
            color,
            (opacityMax * k) / (RED_SCAN_OPACITIES - 1),
            background,
          );
          if (
            isSaturatedRed(rgb) ||
            ratio(rgb.r, rgb.g, rgb.b) >= RED_CAPABLE_RATIO ||
            ratio(linear(rgb.r), linear(rgb.g), linear(rgb.b)) >=
              RED_CAPABLE_RATIO
          ) {
            return true;
          }
        }
      }
    }
  }
  return false;
}

const models = new WeakMap<DorcasModePalette, ModeModel>();

function modelFor(palette: DorcasModePalette): ModeModel {
  let model = models.get(palette);
  if (!model) {
    const sources = sourcesOf(palette);
    const surfaces: Surface[] = [];
    for (const [bgName, background] of backgroundsOf(palette)) {
      for (const { name, glow, token } of sources) {
        const fractions = glow
          ? motionTrackedFractions(token, background, glow)
          : [1];
        surfaces.push({
          source: name,
          glow,
          token,
          background,
          fractions,
          keys: fractions.map((f) => `${palette.mode}/${name}@${f}/${bgName}`),
        });
      }
    }
    model = { mode: palette.mode, sources, surfaces };
    models.set(palette, model);
  }
  return model;
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

  constructor(private readonly windowMs: number) {}

  private next(nowMs: number, value: number): TrackerStep {
    return ReversalChannel.advance(this.state, nowMs, value);
  }

  private static advance(
    s: TrackerState | null,
    nowMs: number,
    value: number,
  ): TrackerStep {
    const fresh = { extreme: value, leftExtremeMs: null };
    const quiet = { leaving: false, reversalAtMs: null };
    if (s === null) return { state: { direction: 0, ...fresh }, ...quiet };
    if (s.direction === 0) {
      if (Math.abs(value - s.extreme) <= MOTION_DEAD_BAND) {
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
    if (-along <= MOTION_DEAD_BAND) {
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
    return this.times.filter((t) => t > nowMs - this.windowMs).length >= max;
  }

  strandsDrop(
    nowMs: number,
    value: number,
    drop: number,
    max: number,
  ): boolean {
    const first = this.next(nowMs, value);
    if (!ReversalChannel.advance(first.state, nowMs, drop).leaving) {
      return false;
    }
    const times =
      first.reversalAtMs === null
        ? this.times
        : [...this.times, first.reversalAtMs];
    return times.filter((t) => t > nowMs - this.windowMs).length >= max;
  }

  commit(nowMs: number, value: number): void {
    const { state, reversalAtMs } = this.next(nowMs, value);
    this.state = state;
    if (reversalAtMs !== null) this.times.push(reversalAtMs);
    const earliestNext = state.leftExtremeMs ?? nowMs;
    this.times = this.times.filter((t) => t > earliestNext - this.windowMs);
  }
}

export interface MotionGovernorOptions {
  palettes?: readonly DorcasModePalette[];
  maxReversals?: number;
  windowMs?: number;
}

export class MotionGovernor {
  private readonly modes: ModeModel[];
  private readonly redCapable: boolean;
  private readonly channels = new Map<string, ReversalChannel>();
  private readonly maxReversals: number;
  private readonly windowMs: number;
  private moveTimes: number[] = [];
  private hueMoveTimes: number[] = [];
  private last: MotionValues | null = null;
  private lastRenderedHue: number | null = null;
  private lastRenderedGlow = 0;

  constructor(options: MotionGovernorOptions = {}) {
    const palettes = options.palettes ?? DORCAS_PALETTES;
    this.modes = palettes.map(modelFor);
    this.redCapable = palettes.some(redCapablePalette);
    this.maxReversals = options.maxReversals ?? MOTION_MAX_REVERSALS;
    this.windowMs = options.windowMs ?? MOTION_WINDOW_MS;
  }

  get current(): MotionValues | null {
    return this.last;
  }

  step(nowMs: number, candidate: MotionCandidate): MotionValues {
    const ambientHue = normalizeHue(candidate.ambientHue);
    const requested: MotionValues = {
      hue: candidate.hue === null ? null : normalizeHue(candidate.hue),
      glow: Math.min(MOTION_MAX_GLOW, Math.max(0, candidate.glow)),
    };
    this.moveTimes = this.moveTimes.filter((t) => t > nowMs - this.windowMs);
    this.hueMoveTimes = this.hueMoveTimes.filter(
      (t) => t > nowMs - this.windowMs,
    );
    const shown = candidate.glowShown;
    const reserve = shown && candidate.reserveGlowDrop;
    const options = this.alternatives(requested, ambientHue, shown);
    for (const option of options) {
      const samples = this.sample(option, ambientHue, shown);
      if (
        this.withinBudget(nowMs, option, ambientHue, shown, reserve, samples)
      ) {
        return this.commit(nowMs, option, ambientHue, shown, samples);
      }
    }
    const held = options[options.length - 1];
    return this.commit(
      nowMs,
      held,
      ambientHue,
      shown,
      this.sample(held, ambientHue, shown),
    );
  }

  private alternatives(
    requested: MotionValues,
    ambientHue: number,
    shown: boolean,
  ): MotionValues[] {
    const last = this.last;
    if (last === null || this.lastRenderedHue === null) return [requested];
    const ambientUnchanged =
      Math.abs(hueArc(this.lastRenderedHue, ambientHue)) < 1e-9;
    const heldHue =
      last.hue === null && ambientUnchanged ? null : this.lastRenderedHue;
    const heldGlow = shown ? this.lastRenderedGlow : requested.glow;
    return [
      requested,
      { hue: heldHue, glow: requested.glow },
      { hue: requested.hue, glow: heldGlow },
      { hue: heldHue, glow: heldGlow },
    ];
  }

  private movesHue(values: MotionValues, ambientHue: number): boolean {
    if (this.lastRenderedHue === null) return false;
    return (values.hue ?? ambientHue) !== this.lastRenderedHue;
  }

  private writesHue(values: MotionValues, ambientHue: number): boolean {
    if (values.hue === null && this.last?.hue === null) return false;
    return this.movesHue(values, ambientHue);
  }

  private moves(
    values: MotionValues,
    ambientHue: number,
    shown: boolean,
  ): boolean {
    if (this.last === null) return false;
    return (
      this.movesHue(values, ambientHue) ||
      (shown ? values.glow : 0) !== this.lastRenderedGlow
    );
  }

  private sample(
    values: MotionValues,
    ambientHue: number,
    shown: boolean,
  ): Map<string, number> {
    const hue = values.hue ?? ambientHue;
    const glow = shown ? values.glow : 0;
    const out = new Map<string, number>();
    for (const mode of this.modes) {
      const colors = new Map(
        mode.sources.map(({ name, token }) => [name, sourceRgb(token, hue)]),
      );
      let primarySum = 0;
      for (const surface of mode.surfaces) {
        const color = colors.get(surface.source)!;
        const opacity = surface.token.alpha * (surface.glow ? glow : 1);
        primarySum += relativeLuminance(
          composite(color, opacity, surface.background),
        );
        surface.fractions.forEach((fraction, i) => {
          out.set(
            surface.keys[i],
            relativeLuminance(
              composite(color, opacity * fraction, surface.background),
            ),
          );
        });
      }
      out.set(`${mode.mode}/combined`, primarySum / mode.surfaces.length);
    }
    return out;
  }

  private channelFor(key: string): ReversalChannel {
    let channel = this.channels.get(key);
    if (!channel) {
      channel = new ReversalChannel(this.windowMs);
      this.channels.set(key, channel);
    }
    return channel;
  }

  private withinBudget(
    nowMs: number,
    values: MotionValues,
    ambientHue: number,
    shown: boolean,
    reserve: boolean,
    samples: Map<string, number>,
  ): boolean {
    const reserveDrop = reserve && values.glow > 0;
    if (
      this.redCapable &&
      this.moves(values, ambientHue, shown) &&
      this.moveTimes.length + (reserveDrop ? 1 : 0) >= this.maxReversals
    ) {
      return false;
    }
    if (
      this.writesHue(values, ambientHue) &&
      this.hueMoveTimes.length >= this.maxReversals
    ) {
      return false;
    }
    for (const [key, value] of samples) {
      if (this.channelFor(key).exceeds(nowMs, value, this.maxReversals)) {
        return false;
      }
    }
    if (!reserveDrop) return true;
    const hidden = this.sample(values, ambientHue, false);
    for (const [key, value] of samples) {
      const drop = hidden.get(key)!;
      if (
        this.channelFor(key).strandsDrop(nowMs, value, drop, this.maxReversals)
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
    shown: boolean,
    samples: Map<string, number>,
  ): MotionValues {
    if (this.moves(values, ambientHue, shown)) this.moveTimes.push(nowMs);
    if (this.writesHue(values, ambientHue)) this.hueMoveTimes.push(nowMs);
    for (const [key, value] of samples) {
      this.channelFor(key).commit(nowMs, value);
    }
    this.last = values;
    this.lastRenderedHue = values.hue ?? ambientHue;
    this.lastRenderedGlow = shown ? values.glow : 0;
    return values;
  }
}
