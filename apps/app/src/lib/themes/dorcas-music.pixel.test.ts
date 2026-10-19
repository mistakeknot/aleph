import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright-core";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createPaletteRenderer,
  DORCAS_PALETTES,
  hexToRgb,
  type DorcasModePalette,
  type Rgb,
} from "@/lib/music/dorcas-colors";
import { MOTION_MAX_GLOW } from "@/lib/music/motion-governor";
import { keyHue, REST_GLOW_MAX } from "@/lib/music/music-motion";
import {
  MUSIC_ATTRIBUTE,
  MUSIC_GLOW_PROPERTY,
  MUSIC_HUE_PROPERTY,
} from "@/lib/music/music-signal-controller";
import { dorcasThemeCss } from "./dorcas";

const TOLERANCE_LEVELS = 3;
const WIDTH = 720;
const HEIGHT = 240;
const SIDEBAR_WIDTH = 240;
const ROW_WIDTH = 200;
const SAMPLE = 4;
const PROMPTBOX_LINE_OPACITY = 0.6;

const TOKEN_VARIABLES: Readonly<Record<string, string>> = {
  line: "--dorcas-line",
  wash: "--dorcas-wash",
  seam: "--border-seam",
  input: "--input",
};

const themeCss = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "../../components/ui/theme.css",
  ),
  "utf8",
);

function shippedSidebarMix(selector: RegExp): string {
  const body = selector.exec(themeCss)?.[1];
  const value = body && /\n\s*--sidebar:\s*([^;]+);/.exec(body)?.[1];
  if (!value) throw new Error(`missing --sidebar in ${selector}`);
  return value.trim();
}

const sidebarCss = `
:root, .light { --sidebar: ${shippedSidebarMix(/\n:root,\n\.light \{([^}]*)\}/)}; }
.dark { --sidebar: ${shippedSidebarMix(/\n\.dark \{([^}]*)\}/)}; }
`;

interface Region {
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Layout {
  html: string;
  regions: Region[];
}

function washFractionAt(x: number): number {
  return 1 - (x + SAMPLE / 2) / (ROW_WIDTH * 0.72);
}

function layoutFor(palette: DorcasModePalette): Layout {
  const regions: Region[] = [];
  const swatches: string[] = [];
  const tokens = Object.keys(palette.hueTokens);
  tokens.forEach((token, index) => {
    const variable = TOKEN_VARIABLES[token];
    if (!variable) throw new Error(`no CSS variable for ${token}`);
    for (const [background, left] of [
      ["sidebar", 16],
      ["canvas", SIDEBAR_WIDTH + 40],
    ] as const) {
      const top = 64 + index * 40;
      swatches.push(
        `<div style="position:absolute;left:${left}px;top:${top}px;width:32px;height:32px;background-color:var(${variable})"></div>`,
      );
      regions.push({
        name: `${token}/${background}`,
        x: left + 14,
        y: top + 14,
        width: SAMPLE,
        height: SAMPLE,
      });
    }
  });
  regions.push({
    name: "glow/sidebar",
    x: SIDEBAR_WIDTH - 2,
    y: 200,
    width: 2,
    height: SAMPLE,
  });
  regions.push({
    name: "canvas",
    x: SIDEBAR_WIDTH + 200,
    y: 200,
    width: SAMPLE,
    height: SAMPLE,
  });
  for (const x of [0, 60]) {
    regions.push({
      name: `wash@${washFractionAt(x)}/sidebar`,
      x,
      y: 18,
      width: SAMPLE,
      height: SAMPLE,
    });
  }
  regions.push({
    name: `line@${PROMPTBOX_LINE_OPACITY}/canvas`,
    x: SIDEBAR_WIDTH + 120,
    y: 0,
    width: SAMPLE,
    height: 1,
  });
  const border =
    palette.mode === "dark"
      ? `<div style="position:absolute;left:${SIDEBAR_WIDTH + 400}px;top:120px;width:48px;height:48px;box-sizing:border-box;border:8px solid var(--border)"></div>`
      : "";
  if (palette.mode === "dark") {
    regions.push({
      name: "line/canvas",
      x: SIDEBAR_WIDTH + 402,
      y: 122,
      width: SAMPLE,
      height: SAMPLE,
    });
  }
  const html = `<!doctype html>
<html class="${palette.mode}">
<head><style>
${sidebarCss}
${dorcasThemeCss}
html, body { margin: 0; }
body { display: flex; width: ${WIDTH}px; height: ${HEIGHT}px; background-color: var(--canvas); overflow: hidden; }
[data-sidebar="sidebar"] { flex: none; width: ${SIDEBAR_WIDTH}px; height: ${HEIGHT}px; background-color: var(--sidebar); }
.bb-sidebar-selected-row { position: absolute; left: 0; top: 0; width: ${ROW_WIDTH}px; height: 40px; }
main { position: relative; flex: 1; }
form[data-promptbox] { position: absolute; left: 80px; top: 0; width: 160px; height: 40px; margin: 0; }
</style></head>
<body>
<div data-sidebar="sidebar"><div class="bb-sidebar-selected-row"><div data-sidebar-thread-id="t"></div></div></div>
<main><form data-promptbox></form></main>
${swatches.join("\n")}
${border}
</body>
</html>`;
  return { html, regions };
}

interface MusicState {
  hue: number | null;
  glow: number;
}

function formattedHue(hue: number): string {
  return String(Math.round(hue * 100) / 100);
}

async function applyState(page: Page, state: MusicState): Promise<void> {
  await page.evaluate(
    ({ attribute, hueProperty, glowProperty, hue, glow }) => {
      const root = document.documentElement;
      root.style.removeProperty(hueProperty);
      root.style.removeProperty(glowProperty);
      root.removeAttribute(attribute);
      if (hue === null) return;
      root.setAttribute(attribute, "");
      root.style.setProperty(hueProperty, hue);
      if (glow !== "") root.style.setProperty(glowProperty, glow);
    },
    {
      attribute: MUSIC_ATTRIBUTE,
      hueProperty: MUSIC_HUE_PROPERTY,
      glowProperty: MUSIC_GLOW_PROPERTY,
      hue: state.hue === null ? null : formattedHue(state.hue),
      glow: state.glow > 0 ? state.glow.toFixed(3) : "",
    },
  );
}

async function capture(page: Page): Promise<(region: Region) => Rgb> {
  const png = await page.screenshot({ type: "png", animations: "disabled" });
  const { data, info } = await sharp(png)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return (region) => {
    const sum = [0, 0, 0];
    for (let dy = 0; dy < region.height; dy += 1) {
      for (let dx = 0; dx < region.width; dx += 1) {
        const at =
          ((region.y + dy) * info.width + region.x + dx) * info.channels;
        for (let c = 0; c < 3; c += 1) sum[c] += data[at + c];
      }
    }
    const n = region.width * region.height * 255;
    return { r: sum[0] / n, g: sum[1] / n, b: sum[2] / n };
  };
}

function predicted(
  palette: DorcasModePalette,
  regions: readonly Region[],
  state: MusicState,
): Map<string, Rgb> {
  const fractions = new Set<number>([1]);
  for (const region of regions) {
    const fraction = /@([\d.]+)\//.exec(region.name)?.[1];
    if (fraction) fractions.add(Number(fraction));
  }
  const hue = state.hue === null ? 350 : Number(formattedHue(state.hue));
  const glow = state.hue === null ? 0 : Number(state.glow.toFixed(3));
  const renderer = createPaletteRenderer(palette, [...fractions]);
  const out = new Map<string, Rgb>();
  for (const element of renderer.render(hue, glow)) {
    out.set(element.name, element.rgb);
  }
  out.set("canvas", hexToRgb(palette.canvas));
  return out;
}

const STATES: readonly MusicState[] = [
  { hue: null, glow: 0 },
  { hue: keyHue(0, "major"), glow: MOTION_MAX_GLOW },
  { hue: keyHue(1, "minor"), glow: REST_GLOW_MAX },
  { hue: keyHue(4, "major"), glow: 0 },
  { hue: keyHue(7, "minor"), glow: 0.25 },
  { hue: 263.37, glow: MOTION_MAX_GLOW },
];

let browser: Browser;

beforeAll(async () => {
  browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || undefined,
    args: ["--force-color-profile=srgb"],
  });
});

afterAll(async () => {
  await browser?.close();
});

describe("Dorcas music mode in Chromium", () => {
  for (const palette of DORCAS_PALETTES) {
    it(`paints the governor's predicted colours on the ${palette.mode} canvas`, async () => {
      const page = await browser.newPage({
        viewport: { width: WIDTH, height: HEIGHT },
        deviceScaleFactor: 1,
      });
      try {
        const layout = layoutFor(palette);
        await page.setContent(layout.html, { waitUntil: "load" });
        const failures: string[] = [];
        let worst = 0;
        for (const state of STATES) {
          await applyState(page, state);
          const sample = await capture(page);
          const expected = predicted(palette, layout.regions, state);
          for (const region of layout.regions) {
            const want = expected.get(region.name);
            if (!want) throw new Error(`no prediction for ${region.name}`);
            const got = sample(region);
            const delta = Math.max(
              Math.abs(got.r - want.r),
              Math.abs(got.g - want.g),
              Math.abs(got.b - want.b),
            );
            worst = Math.max(worst, delta * 255);
            if (delta * 255 > TOLERANCE_LEVELS) {
              const levels = (rgb: Rgb) =>
                [rgb.r, rgb.g, rgb.b]
                  .map((c) => (c * 255).toFixed(1))
                  .join(",");
              failures.push(
                `hue ${state.hue} glow ${state.glow} ${region.name}: got ${levels(got)} want ${levels(want)}`,
              );
            }
          }
        }
        expect(failures).toEqual([]);
        expect(worst).toBeLessThanOrEqual(TOLERANCE_LEVELS);
      } finally {
        await page.close();
      }
    });
  }
});
