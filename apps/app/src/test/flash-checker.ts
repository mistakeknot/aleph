import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { dorcasThemeCss } from "@/lib/themes/dorcas";

type Vec3 = readonly [number, number, number];
type Mat3 = readonly [Vec3, Vec3, Vec3];

const OKLAB_TO_LMS: Mat3 = [
  [1, 0.3963377773761749, 0.2158037573099136],
  [1, -0.1055613458156586, -0.0638541728258133],
  [1, -0.0894841775298119, -1.2914855480194092],
];
const LMS_TO_XYZ: Mat3 = [
  [1.2268798758459243, -0.5578149944602171, 0.2813910456659647],
  [-0.0405757452148008, 1.112286803280317, -0.0717110580655164],
  [-0.0763729366746601, -0.4214933324022432, 1.5869240198367816],
];
const XYZ_TO_LINEAR_SRGB: Mat3 = [
  [12831 / 3959, -329 / 214, -1974 / 3959],
  [-851781 / 878810, 1648619 / 878810, 36519 / 878810],
  [705 / 12673, -2585 / 12673, 705 / 667],
];
const LINEAR_SRGB_TO_XYZ: Mat3 = [
  [506752 / 1228815, 87881 / 245763, 12673 / 70218],
  [87098 / 409605, 175762 / 245763, 12673 / 175545],
  [7918 / 409605, 87881 / 737289, 1001167 / 1053270],
];
const XYZ_TO_LMS: Mat3 = [
  [0.819022437996703, 0.3619062600528904, -0.1288737815209879],
  [0.0329836539323885, 0.9292868615863434, 0.0361446663506424],
  [0.0481771893596242, 0.2642395317527308, 0.6335478258136937],
];
const LMS_TO_OKLAB: Mat3 = [
  [0.210454268309314, 0.7936177747023054, -0.0040720430116193],
  [1.9779985324311684, -2.4285922420485799, 0.450593709617411],
  [0.0259040424655478, 0.7827717124575296, -0.8086757549230774],
];

const apply = (m: Mat3, v: Vec3): Vec3 => [
  m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
  m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
  m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
];

const toLinear = (c: number): number => {
  const sign = c < 0 ? -1 : 1;
  const abs = Math.abs(c);
  return abs <= 0.04045 ? c / 12.92 : sign * ((abs + 0.055) / 1.055) ** 2.4;
};

const toGamma = (c: number): number => {
  const sign = c < 0 ? -1 : 1;
  const abs = Math.abs(c);
  return abs > 0.0031308
    ? sign * (1.055 * abs ** (1 / 2.4) - 0.055)
    : 12.92 * c;
};

export interface CheckerOklch {
  l: number;
  c: number;
  h: number | null;
}

export function checkerOklchToSrgb(color: CheckerOklch): {
  srgb: Vec3;
  inGamut: boolean;
} {
  const h = ((color.h ?? 0) * Math.PI) / 180;
  const lab: Vec3 = [color.l, color.c * Math.cos(h), color.c * Math.sin(h)];
  const lms = apply(OKLAB_TO_LMS, lab).map((x) => x ** 3) as unknown as Vec3;
  const linear = apply(XYZ_TO_LINEAR_SRGB, apply(LMS_TO_XYZ, lms));
  const encoded = linear.map(toGamma);
  const inGamut = encoded.every((x) => x >= -1e-6 && x <= 1 + 1e-6);
  return {
    srgb: encoded.map((x) => Math.min(1, Math.max(0, x))) as unknown as Vec3,
    inGamut,
  };
}

export function checkerSrgbToOklch(srgb: Vec3): CheckerOklch {
  const xyz = apply(LINEAR_SRGB_TO_XYZ, srgb.map(toLinear) as unknown as Vec3);
  const lms = apply(XYZ_TO_LMS, xyz).map(Math.cbrt) as unknown as Vec3;
  const [l, a, b] = apply(LMS_TO_OKLAB, lms);
  const c = Math.sqrt(a * a + b * b);
  if (c < 1e-6) return { l, c, h: null };
  let h = (Math.atan2(b, a) * 180) / Math.PI;
  if (h < 0) h += 360;
  return { l, c, h };
}

function checkerHex(hex: string): Vec3 {
  const digits = hex.replace("#", "");
  if (!/^[0-9a-f]{6}$/i.test(digits)) throw new Error(`bad hex ${hex}`);
  return [0, 2, 4].map(
    (at) => Number.parseInt(digits.slice(at, at + 2), 16) / 255,
  ) as unknown as Vec3;
}

function colorMixOklch(first: Vec3, percent: number, second: Vec3): Vec3 {
  const p = percent / 100;
  const a = checkerSrgbToOklch(first);
  const b = checkerSrgbToOklch(second);
  const ha = a.h ?? b.h;
  const hb = b.h ?? a.h;
  let h: number | null = null;
  if (ha !== null && hb !== null) {
    let delta = hb - ha;
    if (delta > 180) delta -= 360;
    if (delta < -180) delta += 360;
    h = ha + delta * (1 - p);
  }
  return checkerOklchToSrgb({
    l: a.l * p + b.l * (1 - p),
    c: a.c * p + b.c * (1 - p),
    h,
  }).srgb;
}

const over = (top: Vec3, alpha: number, bottom: Vec3): Vec3 =>
  top.map((x, i) => x * alpha + bottom[i] * (1 - alpha)) as unknown as Vec3;

export function checkerLuminance(srgb: Vec3): number {
  return apply(LINEAR_SRGB_TO_XYZ, srgb.map(toLinear) as unknown as Vec3)[1];
}

const RED_PRIMARY_XY = { x: 0.64, y: 0.33 };
const RED_PRIMARY_UV = {
  u:
    (4 * RED_PRIMARY_XY.x) /
    (-2 * RED_PRIMARY_XY.x + 12 * RED_PRIMARY_XY.y + 3),
  v:
    (9 * RED_PRIMARY_XY.y) /
    (-2 * RED_PRIMARY_XY.x + 12 * RED_PRIMARY_XY.y + 3),
};

const WHITE_XY = { x: 0.3127, y: 0.329 };
const WHITE_UV = {
  u: (4 * WHITE_XY.x) / (-2 * WHITE_XY.x + 12 * WHITE_XY.y + 3),
  v: (9 * WHITE_XY.y) / (-2 * WHITE_XY.x + 12 * WHITE_XY.y + 3),
};
const CHROMA_FADE_BELOW_Y = 0.01;

export function checkerRedDistance(srgb: Vec3): number {
  const [x, y, z] = apply(
    LINEAR_SRGB_TO_XYZ,
    srgb.map(toLinear) as unknown as Vec3,
  );
  const denominator = x + 15 * y + 3 * z;
  const weight = Math.min(1, y / CHROMA_FADE_BELOW_Y);
  const u =
    denominator > 0
      ? WHITE_UV.u + ((4 * x) / denominator - WHITE_UV.u) * weight
      : WHITE_UV.u;
  const v =
    denominator > 0
      ? WHITE_UV.v + ((9 * y) / denominator - WHITE_UV.v) * weight
      : WHITE_UV.v;
  return Math.sqrt((u - RED_PRIMARY_UV.u) ** 2 + (v - RED_PRIMARY_UV.v) ** 2);
}

export function checkerSaturatedRed(srgb: Vec3): boolean {
  const ratio = (v: Vec3) => {
    const sum = v[0] + v[1] + v[2];
    return sum > 0 ? v[0] / sum : 0;
  };
  return (
    ratio(srgb) >= 0.8 || ratio(srgb.map(toLinear) as unknown as Vec3) >= 0.8
  );
}

export interface CheckerToken {
  l: number;
  c: number;
  alpha: number;
}

export interface CheckerMode {
  mode: "light" | "dark";
  canvas: string;
  ink: string;
  sidebarPercent: number;
  line: CheckerToken;
  tokens: Record<string, CheckerToken>;
}

function block(css: string, selector: RegExp): string {
  const match = selector.exec(css);
  if (!match) throw new Error(`missing block ${selector}`);
  return match[1];
}

function declaration(body: string, name: string): string {
  const match = new RegExp(`${name}:\\s*([^;]+);`).exec(body);
  if (!match) throw new Error(`missing ${name}`);
  return match[1].trim();
}

function hueToken(value: string): CheckerToken {
  const match =
    /^oklch\(([\d.]+) ([\d.]+) var\(--dorcas-hue\)(?: \/ ([\d.]+)%)?\)$/.exec(
      value,
    );
  if (!match) throw new Error(`not a hue-driven oklch token: ${value}`);
  return {
    l: Number(match[1]),
    c: Number(match[2]),
    alpha: match[3] === undefined ? 1 : Number(match[3]) / 100,
  };
}

function sidebarPercent(themeCss: string, selector: RegExp): number {
  const value = declaration(block(themeCss, selector), "--sidebar");
  const match =
    /^color-mix\(in oklch, var\(--ink\) ([\d.]+)%, var\(--canvas\)\)$/.exec(
      value,
    );
  if (!match) throw new Error(`unexpected sidebar mix ${value}`);
  return Number(match[1]);
}

export function readShippedDorcasModes(): CheckerMode[] {
  const themeCss = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../components/ui/theme.css"),
    "utf8",
  );
  const lightBase = block(dorcasThemeCss, /\n:root, \.light \{([^}]*)\}/);
  const darkBase = block(dorcasThemeCss, /\n\.dark \{([^}]*)\}/);
  const html = block(dorcasThemeCss, /\nhtml \{([^}]*)\}/);
  const htmlDark = block(dorcasThemeCss, /\nhtml\.dark \{([^}]*)\}/);
  const lightLine = hueToken(declaration(html, "--dorcas-line"));
  const darkLine = hueToken(declaration(htmlDark, "--dorcas-line"));
  return [
    {
      mode: "light",
      canvas: declaration(lightBase, "--canvas"),
      ink: declaration(lightBase, "--ink"),
      sidebarPercent: sidebarPercent(themeCss, /\n:root,\n\.light \{([^}]*)\}/),
      line: lightLine,
      tokens: {
        line: lightLine,
        wash: hueToken(declaration(html, "--dorcas-wash")),
      },
    },
    {
      mode: "dark",
      canvas: declaration(darkBase, "--canvas"),
      ink: declaration(darkBase, "--ink"),
      sidebarPercent: sidebarPercent(themeCss, /\n\.dark \{([^}]*)\}/),
      line: darkLine,
      tokens: {
        line: darkLine,
        wash: hueToken(declaration(htmlDark, "--dorcas-wash")),
        seam: hueToken(declaration(htmlDark, "--border-seam")),
        input: hueToken(declaration(htmlDark, "--input")),
      },
    },
  ];
}

export function readShippedPromptboxOpacity(): number {
  const match =
    /\nform\[data-promptbox\]::after \{[^}]*\n {2}opacity: ([\d.]+);/.exec(
      dorcasThemeCss,
    );
  if (!match) throw new Error("missing promptbox line opacity");
  return Number(match[1]);
}

export const CHECKER_OPACITY_FRACTIONS: readonly number[] = [
  1, 0.6, 0.45, 0.2, 0.05,
];

export interface CheckerSample {
  luminance: number;
  red: number;
  saturatedRed: boolean;
}

export interface CheckerFrame {
  t: number;
  hue: number;
  glow: number;
}

export function renderCheckerFrame(
  modes: readonly CheckerMode[],
  hue: number,
  glow: number,
  fractions: readonly number[] = CHECKER_OPACITY_FRACTIONS,
): { samples: Map<string, CheckerSample>; outOfGamut: string[] } {
  const samples = new Map<string, CheckerSample>();
  const outOfGamut: string[] = [];
  const measure = (srgb: Vec3): CheckerSample => ({
    luminance: checkerLuminance(srgb),
    red: checkerRedDistance(srgb),
    saturatedRed: checkerSaturatedRed(srgb),
  });
  for (const mode of modes) {
    const canvas = checkerHex(mode.canvas);
    const sidebar = colorMixOklch(
      checkerHex(mode.ink),
      mode.sidebarPercent,
      canvas,
    );
    const sources = [
      { name: "glow", token: mode.line, alpha: mode.line.alpha * glow },
      ...Object.entries(mode.tokens).map(([name, token]) => ({
        name,
        token,
        alpha: token.alpha,
      })),
    ];
    const combined: CheckerSample[] = [];
    for (const [bgName, bg] of [
      ["canvas", canvas],
      ["sidebar", sidebar],
    ] as const) {
      for (const { name, token, alpha } of sources) {
        const color = checkerOklchToSrgb({ l: token.l, c: token.c, h: hue });
        if (!color.inGamut) outOfGamut.push(`${mode.mode}/${name}`);
        for (const fraction of fractions) {
          const sample = measure(over(color.srgb, alpha * fraction, bg));
          const label = fraction === 1 ? name : `${name}@${fraction}`;
          samples.set(`${mode.mode}/${label}/${bgName}`, sample);
          if (fraction === 1) combined.push(sample);
        }
      }
    }
    samples.set(`${mode.mode}/combined`, {
      luminance:
        combined.reduce((sum, s) => sum + s.luminance, 0) / combined.length,
      red: combined.reduce((sum, s) => sum + s.red, 0) / combined.length,
      saturatedRed: combined.some((s) => s.saturatedRed),
    });
  }
  return { samples, outOfGamut };
}

interface SeriesPoint {
  t: number;
  value: number;
  red: boolean;
}

function zigzag(
  series: readonly SeriesPoint[],
  band: number,
  tolerance: number,
  onReversal: (anchor: SeriesPoint, point: SeriesPoint, leftAt: number) => void,
): SeriesPoint | null {
  if (series.length === 0) return null;
  let anchor = series[0];
  let leftAt: number | null = null;
  let trend = 0;
  for (const point of series.slice(1)) {
    const delta = point.value - anchor.value;
    if (trend === 0) {
      if (Math.abs(delta) > band) {
        trend = Math.sign(delta);
        anchor = point;
      }
      continue;
    }
    const along = delta * trend;
    if (along > tolerance) {
      anchor = point;
      leftAt = null;
      continue;
    }
    if (along >= -tolerance) continue;
    leftAt ??= point.t;
    if (-along > band) {
      onReversal(anchor, point, leftAt);
      trend = -trend;
      anchor = point;
      leftAt = null;
    }
  }
  return anchor;
}

export function zigzagReversals(
  series: readonly SeriesPoint[],
  band: number,
  tolerance: number,
  redGated: boolean,
): number[] {
  const reversals: number[] = [];
  zigzag(series, band, tolerance, (anchor, point, leftAt) => {
    if (!redGated || point.red || anchor.red) reversals.push(leftAt);
  });
  return reversals;
}

export function flashReversals(
  series: readonly SeriesPoint[],
  onsetBand: number,
  flashBand: number,
  tolerance: number,
  redGated: boolean,
  qualifies: (from: number, to: number) => boolean = () => true,
): number[] {
  if (series.length === 0) return [];
  const turns: SeriesPoint[] = [series[0]];
  let legRed = series[0].red;
  let index = 0;
  const last = zigzag(series, onsetBand, tolerance, (anchor, point, leftAt) => {
    while (series[index] !== point) {
      index += 1;
      legRed = legRed || series[index].red;
    }
    turns.push({ t: leftAt, value: anchor.value, red: legRed });
    legRed = point.red;
  });
  if (last !== null) {
    legRed = legRed || series.slice(index).some((point) => point.red);
    turns.push({ t: Infinity, value: last.value, red: legRed });
  }
  const reversals: number[] = [];
  zigzag(turns, flashBand, 0, (anchor, point) => {
    if (
      (!redGated || point.red || anchor.red) &&
      qualifies(anchor.value, point.value)
    ) {
      reversals.push(anchor.t);
    }
  });
  return reversals;
}

export function maxInWindow(
  times: readonly number[],
  windowMs: number,
): number {
  let best = 0;
  let start = 0;
  for (let end = 0; end < times.length; end++) {
    while (times[end] - times[start] >= windowMs) start++;
    best = Math.max(best, end - start + 1);
  }
  return best;
}

export interface FlashReport {
  worst: { channel: string; count: number };
  maxGlow: number;
  luminanceRange: Map<string, { min: number; max: number }>;
  outOfGamut: string[];
}

export interface FlashRule {
  fractions: readonly number[];
  onsetBand: number;
  extremeTolerance: number;
  flash: { luminance: number; red: number; darkerBelow: number } | null;
}

export const strictRule = (
  fractions: readonly number[],
  band: number,
  extremeTolerance: number,
): FlashRule => ({ fractions, onsetBand: band, extremeTolerance, flash: null });

export const WCAG_FLASH_RULE: FlashRule = {
  fractions: CHECKER_OPACITY_FRACTIONS,
  onsetBand: 0.005,
  extremeTolerance: 1e-4,
  flash: { luminance: 0.1, red: 0.2, darkerBelow: 0.8 },
};

export function checkFlashes(
  modes: readonly CheckerMode[],
  frames: readonly CheckerFrame[],
  rule: FlashRule,
): FlashReport {
  const series = new Map<
    string,
    {
      luminance: { t: number; value: number; red: boolean }[];
      red: { t: number; value: number; red: boolean }[];
    }
  >();
  const luminanceRange = new Map<string, { min: number; max: number }>();
  const outOfGamut = new Set<string>();
  let maxGlow = 0;
  for (const frame of frames) {
    maxGlow = Math.max(maxGlow, frame.glow);
    const rendered = renderCheckerFrame(
      modes,
      frame.hue,
      frame.glow,
      rule.fractions,
    );
    for (const name of rendered.outOfGamut) outOfGamut.add(name);
    for (const [name, sample] of rendered.samples) {
      let entry = series.get(name);
      if (!entry) {
        entry = { luminance: [], red: [] };
        series.set(name, entry);
      }
      entry.luminance.push({ t: frame.t, value: sample.luminance, red: false });
      entry.red.push({
        t: frame.t,
        value: sample.red,
        red: sample.saturatedRed,
      });
      const range = luminanceRange.get(name) ?? {
        min: Infinity,
        max: -Infinity,
      };
      range.min = Math.min(range.min, sample.luminance);
      range.max = Math.max(range.max, sample.luminance);
      luminanceRange.set(name, range);
    }
  }
  const flash = rule.flash;
  let worst = { channel: "none", count: 0 };
  for (const [name, entry] of series) {
    const luminance = flash
      ? flashReversals(
          entry.luminance,
          rule.onsetBand,
          flash.luminance,
          rule.extremeTolerance,
          false,
          (from, to) => Math.min(from, to) < flash.darkerBelow,
        )
      : zigzagReversals(
          entry.luminance,
          rule.onsetBand,
          rule.extremeTolerance,
          false,
        );
    const red = flash
      ? flashReversals(
          entry.red,
          rule.onsetBand,
          flash.red,
          rule.extremeTolerance,
          true,
        )
      : zigzagReversals(
          entry.red,
          rule.onsetBand,
          rule.extremeTolerance,
          false,
        );
    for (const [kind, times] of [
      ["luminance", luminance],
      ["red", red],
    ] as const) {
      const count = maxInWindow(times, 1000);
      if (count > worst.count) worst = { channel: `${name}/${kind}`, count };
    }
  }
  return { worst, maxGlow, luminanceRange, outOfGamut: [...outOfGamut] };
}
