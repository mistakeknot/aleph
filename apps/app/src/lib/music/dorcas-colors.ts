export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export interface Oklch {
  l: number;
  c: number;
  h: number;
}

export interface HueToken {
  l: number;
  c: number;
  alpha: number;
}

export interface DorcasModePalette {
  mode: "light" | "dark";
  canvas: string;
  ink: string;
  sidebarInkPercent: number;
  glow: HueToken;
  hueTokens: Readonly<Record<string, HueToken>>;
}

export const DORCAS_PALETTES: readonly DorcasModePalette[] = [
  {
    mode: "light",
    canvas: "#ede4e8",
    ink: "#3a2631",
    sidebarInkPercent: 2.2,
    glow: { l: 0.55, c: 0.08, alpha: 1 },
    hueTokens: {
      line: { l: 0.55, c: 0.08, alpha: 1 },
      wash: { l: 0.55, c: 0.08, alpha: 0.1 },
    },
  },
  {
    mode: "dark",
    canvas: "#000000",
    ink: "#cfc5cc",
    sidebarInkPercent: 4.3,
    glow: { l: 0.36, c: 0.06, alpha: 1 },
    hueTokens: {
      line: { l: 0.36, c: 0.06, alpha: 1 },
      wash: { l: 0.5, c: 0.08, alpha: 0.12 },
      seam: { l: 0.22, c: 0.035, alpha: 1 },
      input: { l: 0.42, c: 0.065, alpha: 1 },
    },
  },
];

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));

export function normalizeHue(h: number): number {
  const r = h % 360;
  return r < 0 ? r + 360 : r;
}

export function hueArc(from: number, to: number): number {
  const d = normalizeHue(to - from);
  return d > 180 ? d - 360 : d;
}

function encode(c: number): number {
  return c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
}

function decode(c: number): number {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export function hexToRgb(hex: string): Rgb {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) throw new Error(`not a #rrggbb colour: ${hex}`);
  return {
    r: Number.parseInt(m[1], 16) / 255,
    g: Number.parseInt(m[2], 16) / 255,
    b: Number.parseInt(m[3], 16) / 255,
  };
}

export function oklchToRgb({ l, c, h }: Oklch): Rgb {
  const rad = (h * Math.PI) / 180;
  const a = c * Math.cos(rad);
  const b = c * Math.sin(rad);
  const l1 = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m1 = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s1 = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return {
    r: encode(
      clamp01(4.0767416621 * l1 - 3.3077115913 * m1 + 0.2309699292 * s1),
    ),
    g: encode(
      clamp01(-1.2684380046 * l1 + 2.6097574011 * m1 - 0.3413193965 * s1),
    ),
    b: encode(
      clamp01(-0.0041960863 * l1 - 0.7034186147 * m1 + 1.707614701 * s1),
    ),
  };
}

export function rgbToOklch(rgb: Rgb): Oklch {
  const r = decode(rgb.r);
  const g = decode(rgb.g);
  const b = decode(rgb.b);
  const l1 = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m1 = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s1 = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l1 + 0.793617785 * m1 - 0.0040720468 * s1;
  const A = 1.9779984951 * l1 - 2.428592205 * m1 + 0.4505937099 * s1;
  const B = 0.0259040371 * l1 + 0.7827717662 * m1 - 0.808675766 * s1;
  return {
    l: L,
    c: Math.hypot(A, B),
    h: normalizeHue((Math.atan2(B, A) * 180) / Math.PI),
  };
}

const POWERLESS_CHROMA = 1e-4;

export function mixInOklch(first: Rgb, firstPercent: number, second: Rgb): Rgb {
  const p = firstPercent / 100;
  const x = rgbToOklch(first);
  const y = rgbToOklch(second);
  const xh = x.c < POWERLESS_CHROMA ? y.h : x.h;
  const yh = y.c < POWERLESS_CHROMA ? x.h : y.h;
  return oklchToRgb({
    l: x.l * p + y.l * (1 - p),
    c: x.c * p + y.c * (1 - p),
    h: normalizeHue(yh + hueArc(yh, xh) * p),
  });
}

export function composite(top: Rgb, alpha: number, bottom: Rgb): Rgb {
  return {
    r: top.r * alpha + bottom.r * (1 - alpha),
    g: top.g * alpha + bottom.g * (1 - alpha),
    b: top.b * alpha + bottom.b * (1 - alpha),
  };
}

export function relativeLuminance(rgb: Rgb): number {
  return (
    0.212639 * decode(rgb.r) +
    0.7151687 * decode(rgb.g) +
    0.0721923 * decode(rgb.b)
  );
}

export const SATURATED_RED_RATIO = 0.8;

export function isSaturatedRed(rgb: Rgb): boolean {
  const ratio = (r: number, g: number, b: number) =>
    r + g + b > 0 ? r / (r + g + b) : 0;
  return (
    ratio(rgb.r, rgb.g, rgb.b) >= SATURATED_RED_RATIO ||
    ratio(decode(rgb.r), decode(rgb.g), decode(rgb.b)) >= SATURATED_RED_RATIO
  );
}

const D65_UV = { u: 0.19783, v: 0.46832 };

export function chromaticityUv(rgb: Rgb): { u: number; v: number } {
  const r = decode(rgb.r);
  const g = decode(rgb.g);
  const b = decode(rgb.b);
  const X = 0.4123908 * r + 0.3575843 * g + 0.1804808 * b;
  const Y = 0.212639 * r + 0.7151687 * g + 0.0721923 * b;
  const Z = 0.0193308 * r + 0.1191948 * g + 0.9505322 * b;
  const d = X + 15 * Y + 3 * Z;
  if (d <= 0) return D65_UV;
  return { u: (4 * X) / d, v: (9 * Y) / d };
}

export const RENDER_OPACITY_FRACTIONS: readonly number[] = [1, 0.6, 0.3, 0.1];

export interface RenderedElement {
  name: string;
  primary: boolean;
  rgb: Rgb;
}

export interface PaletteRenderer {
  mode: DorcasModePalette["mode"];
  render(hue: number, glow: number): RenderedElement[];
}

export function createPaletteRenderer(
  palette: DorcasModePalette,
  fractions: readonly number[] = RENDER_OPACITY_FRACTIONS,
): PaletteRenderer {
  const canvas = hexToRgb(palette.canvas);
  const sidebar = mixInOklch(
    hexToRgb(palette.ink),
    palette.sidebarInkPercent,
    canvas,
  );
  const backgrounds = [
    ["canvas", canvas],
    ["sidebar", sidebar],
  ] as const;
  const tokens = Object.entries(palette.hueTokens);
  return {
    mode: palette.mode,
    render(hue, glow) {
      const sources = [
        {
          name: "glow",
          rgb: oklchToRgb({ l: palette.glow.l, c: palette.glow.c, h: hue }),
          alpha: palette.glow.alpha * glow,
        },
        ...tokens.map(([name, token]) => ({
          name,
          rgb: oklchToRgb({ l: token.l, c: token.c, h: hue }),
          alpha: token.alpha,
        })),
      ];
      const out: RenderedElement[] = [];
      for (const [bgName, bg] of backgrounds) {
        for (const source of sources) {
          for (const fraction of fractions) {
            out.push({
              name:
                fraction === 1
                  ? `${source.name}/${bgName}`
                  : `${source.name}@${fraction}/${bgName}`,
              primary: fraction === 1,
              rgb: composite(source.rgb, source.alpha * fraction, bg),
            });
          }
        }
      }
      return out;
    },
  };
}
