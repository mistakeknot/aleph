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
export const MOTION_REENTRY_MS = 1000;

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
}

interface Surface {
  source: string;
  glow: boolean;
  token: HueToken;
  background: Rgb;
  fractions: readonly number[];
}

interface ModeModel {
  mode: DorcasModePalette["mode"];
  redCapable: boolean;
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
    for (const [, background] of backgroundsOf(palette)) {
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
        });
      }
    }
    model = {
      mode: palette.mode,
      sources,
      surfaces,
      redCapable: redCapablePalette(palette),
    };
    models.set(palette, model);
  }
  return model;
}

class ReversalChannel {
  private direction: -1 | 0 | 1 = 0;
  private extreme = 0;
  private leftExtremeMs: number | null = null;
  private lastValue: number | null = null;
  private times: number[] = [];

  constructor(private readonly windowMs: number) {}

  exceeds(nowMs: number, value: number, max: number): boolean {
    if (
      value === this.lastValue ||
      this.direction === 0 ||
      this.leftExtremeMs !== null ||
      (value - this.extreme) * this.direction >= -MOTION_EXTREME_TOLERANCE
    )
      return false;
    let count = 0;
    for (const time of this.times) {
      if (time > nowMs - this.windowMs && ++count >= max) return true;
    }
    return false;
  }

  commit(nowMs: number, value: number): void {
    if (value === this.lastValue) return;
    const initial = this.lastValue === null;
    this.lastValue = value;
    if (initial) {
      this.extreme = value;
      return;
    }
    if (this.direction === 0) {
      if (Math.abs(value - this.extreme) > MOTION_DEAD_BAND) {
        this.direction = value > this.extreme ? 1 : -1;
        this.extreme = value;
      }
      return;
    }
    const along = (value - this.extreme) * this.direction;
    if (along > MOTION_EXTREME_TOLERANCE) {
      this.extreme = value;
      this.leftExtremeMs = null;
    } else if (along < -MOTION_EXTREME_TOLERANCE) {
      this.leftExtremeMs ??= nowMs;
      if (-along > MOTION_DEAD_BAND) {
        this.times.push(this.leftExtremeMs);
        this.direction = this.direction === 1 ? -1 : 1;
        this.extreme = value;
        this.leftExtremeMs = null;
      }
    }
    const cutoff = (this.leftExtremeMs ?? nowMs) - this.windowMs;
    while (this.times.length > 0 && this.times[0] <= cutoff) this.times.shift();
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
  private readonly channels: ReversalChannel[];
  private readonly maxReversals: number;
  private readonly windowMs: number;
  private moveTimes: number[] = [];
  private hueMoveTimes: number[] = [];
  private last: MotionValues | null = null;
  private lastRenderedHue: number | null = null;
  private lastRenderedGlow = 0;
  private glowBlockedUntil = -Infinity;
  private readonly sampleCache = new Map<string, Float64Array>();
  private readonly colorCache = new Map<number, Map<Surface, Rgb>>();

  constructor(options: MotionGovernorOptions = {}) {
    const palettes = options.palettes ?? DORCAS_PALETTES;
    this.modes = palettes.map(modelFor);
    this.redCapable = this.modes.some((mode) => mode.redCapable);
    this.maxReversals = options.maxReversals ?? MOTION_MAX_REVERSALS;
    this.windowMs = options.windowMs ?? MOTION_WINDOW_MS;
    const count = this.modes.reduce(
      (sum, mode) =>
        sum +
        1 +
        mode.surfaces.reduce((n, surface) => n + surface.fractions.length, 0),
      0,
    );
    this.channels = Array.from(
      { length: count },
      () => new ReversalChannel(this.windowMs),
    );
  }

  get current(): MotionValues | null {
    return this.last;
  }

  step(nowMs: number, candidate: MotionCandidate): MotionValues {
    const ambientHue = normalizeHue(candidate.ambientHue);
    if (!candidate.glowShown && this.lastRenderedGlow > 0) {
      this.glowBlockedUntil = nowMs + this.windowMs + MOTION_REENTRY_MS;
      const forced = {
        hue: this.last?.hue ?? null,
        glow: 0,
      };
      if (
        this.lastRenderedHue !== null &&
        forced.hue === null &&
        ambientHue !== this.lastRenderedHue
      ) {
        forced.hue = this.lastRenderedHue;
      }
      return this.commit(
        nowMs,
        forced,
        ambientHue,
        false,
        this.sample(forced, ambientHue, false),
      );
    }
    const requested: MotionValues = {
      hue: candidate.hue === null ? null : normalizeHue(candidate.hue),
      glow:
        !candidate.glowShown || nowMs < this.glowBlockedUntil
          ? 0
          : Math.min(MOTION_MAX_GLOW, Math.max(0, candidate.glow)),
    };
    this.moveTimes = this.moveTimes.filter((t) => t > nowMs - this.windowMs);
    this.hueMoveTimes = this.hueMoveTimes.filter(
      (t) => t > nowMs - this.windowMs,
    );
    const shown = candidate.glowShown;
    const options = this.alternatives(requested, ambientHue, shown);
    for (const option of options) {
      const samples = this.sample(option, ambientHue, shown);
      if (this.withinBudget(nowMs, option, ambientHue, shown, samples)) {
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
      { hue: requested.hue, glow: heldGlow },
      { hue: heldHue, glow: requested.glow },
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
  ): Float64Array {
    const hue = values.hue ?? ambientHue;
    const glow = shown ? values.glow : 0;
    const cacheKey = `${hue}/${glow}`;
    const cached = this.sampleCache.get(cacheKey);
    if (cached) return cached;
    let colors = this.colorCache.get(hue);
    if (!colors) {
      colors = new Map();
      for (const mode of this.modes) {
        const sources = new Map(
          mode.sources.map(({ name, token }) => [name, sourceRgb(token, hue)]),
        );
        for (const surface of mode.surfaces)
          colors.set(surface, sources.get(surface.source)!);
      }
      if (this.colorCache.size >= 8)
        this.colorCache.delete(this.colorCache.keys().next().value!);
      this.colorCache.set(hue, colors);
    }
    const out = new Float64Array(this.channels.length);
    let index = 0;
    for (const mode of this.modes) {
      let primarySum = 0;
      for (const surface of mode.surfaces) {
        const color = colors.get(surface)!;
        const opacity = surface.token.alpha * (surface.glow ? glow : 1);
        const primary = relativeLuminance(
          composite(color, opacity, surface.background),
        );
        primarySum += primary;
        for (const fraction of surface.fractions) {
          out[index++] =
            fraction === 1
              ? primary
              : relativeLuminance(
                  composite(color, opacity * fraction, surface.background),
                );
        }
      }
      out[index++] = primarySum / mode.surfaces.length;
    }
    if (this.sampleCache.size >= 256)
      this.sampleCache.delete(this.sampleCache.keys().next().value!);
    this.sampleCache.set(cacheKey, out);
    return out;
  }

  private withinBudget(
    nowMs: number,
    values: MotionValues,
    ambientHue: number,
    shown: boolean,
    samples: Float64Array,
  ): boolean {
    const movingGlow = (shown ? values.glow : 0) !== this.lastRenderedGlow;
    const hueInFlight = this.hueMoveTimes.length > 0;
    const voluntaryBudget =
      this.maxReversals - 1 - (movingGlow && hueInFlight ? 1 : 0);
    if (
      this.redCapable &&
      this.moves(values, ambientHue, shown) &&
      this.moveTimes.length >= voluntaryBudget
    ) {
      return false;
    }
    if (
      this.writesHue(values, ambientHue) &&
      this.hueMoveTimes.length >= this.maxReversals
    ) {
      return false;
    }
    for (let i = 0; i < samples.length; i++) {
      if (this.channels[i].exceeds(nowMs, samples[i], voluntaryBudget)) {
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
    samples: Float64Array,
  ): MotionValues {
    if (this.moves(values, ambientHue, shown)) this.moveTimes.push(nowMs);
    if (this.writesHue(values, ambientHue)) this.hueMoveTimes.push(nowMs);
    for (let i = 0; i < samples.length; i++) {
      this.channels[i].commit(nowMs, samples[i]);
    }
    this.last = values;
    this.lastRenderedHue = values.hue ?? ambientHue;
    this.lastRenderedGlow = shown ? values.glow : 0;
    return values;
  }
}
