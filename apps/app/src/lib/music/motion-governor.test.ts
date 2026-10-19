import { describe, expect, it } from "vitest";
import {
  checkFlashes,
  readShippedPromptboxOpacity,
  renderCheckerFrame,
  strictRule,
  zigzagReversals,
  type CheckerFrame,
  type CheckerMode,
} from "@/test/flash-checker";
import {
  FLASH_RULES,
  MAX_REVERSALS_PER_SECOND,
  mulberry32,
  PIPELINE_TOLERANCE,
  SHIPPED_DORCAS_MODES,
  STRICT_FLASH_RULE,
} from "@/test/music-motion-support";
import {
  chromaticityUv,
  createPaletteRenderer,
  DORCAS_PALETTES,
  isSaturatedRed,
  oklchToRgb,
  RENDER_OPACITY_FRACTIONS,
  relativeLuminance,
  type DorcasModePalette,
} from "./dorcas-colors";
import {
  MOTION_DEAD_BAND,
  MOTION_EXTREME_TOLERANCE,
  MOTION_MAX_GLOW,
  MotionGovernor,
  redCapablePalette,
  type MotionCandidate,
} from "./motion-governor";

function asCheckerModes(palettes: readonly DorcasModePalette[]): CheckerMode[] {
  return palettes.map((palette) => ({
    mode: palette.mode,
    canvas: palette.canvas,
    ink: palette.ink,
    sidebarPercent: palette.sidebarInkPercent,
    line: palette.glow,
    tokens: { ...palette.hueTokens },
  }));
}

function drive(
  governor: MotionGovernor,
  candidates: readonly (MotionCandidate & { t: number })[],
): CheckerFrame[] {
  return candidates.map(({ t, ...candidate }) => {
    const out = governor.step(t, candidate);
    return {
      t,
      hue: out.hue ?? candidate.ambientHue,
      glow: candidate.glowShown ? out.glow : 0,
    };
  });
}

type Generator = (rand: () => number) => (MotionCandidate & { t: number })[];

const square =
  (field: "glow" | "hue"): Generator =>
  (rand) => {
    const periodTicks = 1 + Math.floor(rand() * 12);
    const low = field === "glow" ? rand() * 0.2 : rand() * 360;
    const high = field === "glow" ? 0.2 + rand() * 0.6 : rand() * 360;
    const out: (MotionCandidate & { t: number })[] = [];
    let t = 0;
    for (let i = 0; i < 240; i++) {
      t += 8 + rand() * 40;
      const on = Math.floor(i / periodTicks) % 2 === 0;
      out.push({
        t,
        hue: field === "hue" ? (on ? high : low) : 200,
        glow: field === "glow" ? (on ? high : low) : 0.2,
        ambientHue: 350,
        glowShown: true,
      });
    }
    return out;
  };

const chaos: Generator = (rand) => {
  const out: (MotionCandidate & { t: number })[] = [];
  let t = 0;
  let ambientHue = rand() * 360;
  for (let i = 0; i < 300; i++) {
    t += rand() < 0.1 ? 0 : 5 + rand() * 60;
    if (rand() < 0.05) ambientHue = rand() * 360;
    out.push({
      t,
      hue: rand() < 0.2 ? null : rand() * 720 - 180,
      glow: rand() * 1.2 - 0.1,
      ambientHue,
      glowShown: true,
    });
  }
  return out;
};

const DENSE_OPACITY_FRACTIONS = [
  0.95, 0.8, 0.5, 0.4, 0.25, 0.17, 0.13, 0.075, 0.055, 0.045, 0.035, 0.022,
  0.015, 0.012,
];

const both: Generator = (rand) => {
  const hues = square("hue")(rand);
  const glows = square("glow")(rand);
  return hues.map((c, i) => ({ ...c, glow: glows[i].glow }));
};

describe("Dorcas colour inputs", () => {
  it("pins the governor's palette to the shipped Dorcas and theme CSS", () => {
    const shipped = SHIPPED_DORCAS_MODES.map((mode) => ({
      mode: mode.mode,
      canvas: mode.canvas,
      ink: mode.ink,
      sidebarInkPercent: mode.sidebarPercent,
      glow: mode.line,
      hueTokens: mode.tokens,
    }));
    expect(DORCAS_PALETTES).toEqual(shipped);
  });

  it("rules on the promptbox line at its shipped opacity", () => {
    expect(RENDER_OPACITY_FRACTIONS).toContain(readShippedPromptboxOpacity());
  });

  it("keeps every hue-driven token inside sRGB at every hue", () => {
    for (let hue = 0; hue < 360; hue += 0.5) {
      expect(
        renderCheckerFrame(SHIPPED_DORCAS_MODES, hue, 0.4).outOfGamut,
      ).toEqual([]);
    }
  });

  it("agrees with the independent checker on every element's colour", () => {
    const renderers = DORCAS_PALETTES.map((palette) =>
      createPaletteRenderer(palette),
    );
    for (let hue = 0; hue < 360; hue += 7.5) {
      for (const glow of [0, 0.005, 0.12, 0.4]) {
        const checked = renderCheckerFrame(
          SHIPPED_DORCAS_MODES,
          hue,
          glow,
          RENDER_OPACITY_FRACTIONS,
        ).samples;
        for (const renderer of renderers) {
          for (const element of renderer.render(hue, glow)) {
            const expected = checked.get(`${renderer.mode}/${element.name}`);
            expect(expected).toBeDefined();
            expect(
              Math.abs(relativeLuminance(element.rgb) - expected!.luminance),
            ).toBeLessThan(PIPELINE_TOLERANCE);
            const uv = chromaticityUv(element.rgb);
            expect(
              Math.hypot(uv.u - expected!.uv.u, uv.v - expected!.uv.v),
            ).toBeLessThan(PIPELINE_TOLERANCE);
            expect(isSaturatedRed(element.rgb)).toBe(expected!.saturatedRed);
          }
        }
      }
    }
  });

  it("never renders a saturated red with the shipped tokens", () => {
    for (let hue = 0; hue < 360; hue += 1) {
      for (const sample of renderCheckerFrame(
        SHIPPED_DORCAS_MODES,
        hue,
        0.4,
      ).samples.values()) {
        expect(sample.saturatedRed).toBe(false);
      }
    }
  });

  it("never renders a saturated red with the shipped tokens at any opacity", () => {
    const fractions = Array.from({ length: 40 }, (_, k) => (k + 1) / 40);
    for (let hue = 0; hue < 360; hue += 1) {
      const { samples } = renderCheckerFrame(
        SHIPPED_DORCAS_MODES,
        hue,
        MOTION_MAX_GLOW,
        fractions,
      );
      const red = [...samples].filter(([, sample]) => sample.saturatedRed);
      expect(red.map(([name]) => `${hue}° ${name}`)).toEqual([]);
    }
  });

  it("treats the shipped palettes as unable to reach saturated red", () => {
    expect(DORCAS_PALETTES.some(redCapablePalette)).toBe(false);
  });

  it("records the glow's peak and trough luminance over both canvases", () => {
    const frames: CheckerFrame[] = [];
    for (let hue = 0; hue < 360; hue += 1) {
      frames.push(
        { t: hue * 2, hue, glow: 0 },
        { t: hue * 2 + 1, hue, glow: MOTION_MAX_GLOW },
      );
    }
    const { luminanceRange } = checkFlashes(
      SHIPPED_DORCAS_MODES,
      frames,
      STRICT_FLASH_RULE,
    );
    const dark = luminanceRange.get("dark/glow/canvas")!;
    const light = luminanceRange.get("light/glow/canvas")!;
    expect(dark.min).toBe(0);
    expect(dark.max).toBeCloseTo(0.0097, 3);
    expect(light.max).toBeCloseTo(0.7932, 3);
    expect(light.min).toBeCloseTo(0.4645, 3);
  });
});

describe("MotionGovernor", () => {
  it("passes the first request through with glow clamped to 0.4", () => {
    const governor = new MotionGovernor();
    expect(
      governor.step(0, {
        hue: 400,
        glow: 0.9,
        ambientHue: 350,
        glowShown: true,
      }),
    ).toEqual({
      hue: 40,
      glow: MOTION_MAX_GLOW,
    });
    expect(governor.current).toEqual({ hue: 40, glow: MOTION_MAX_GLOW });
  });

  it("allows smooth monotonic motion without holding", () => {
    const governor = new MotionGovernor();
    for (let i = 0; i <= 60; i++) {
      const hue = 320 + Math.floor(i / 16) * 8;
      const out = governor.step(i * 16, {
        hue,
        glow: i / 150,
        ambientHue: 350,
        glowShown: true,
      });
      expect(out).toEqual({ hue, glow: i / 150 });
    }
  });

  it("writes a new hue at most 4 times in any second", () => {
    const governor = new MotionGovernor();
    const writes: number[] = [];
    let previous: number | null = null;
    for (let i = 0; i <= 250; i++) {
      const out = governor.step(i * 16, {
        hue: 320 + i * 0.5,
        glow: 0,
        ambientHue: 350,
        glowShown: true,
      });
      if (previous !== null && out.hue !== previous) writes.push(i * 16);
      previous = out.hue;
    }
    expect(writes.length).toBeGreaterThanOrEqual(12);
    for (let i = 4; i < writes.length; i++) {
      expect(writes[i] - writes[i - 4]).toBeGreaterThanOrEqual(1000);
    }
  });

  it("holds glow once the reversal budget for the window is spent", () => {
    const governor = new MotionGovernor();
    const outputs: number[] = [];
    for (let i = 0; i < 30; i++) {
      outputs.push(
        governor.step(i * 33, {
          hue: 200,
          glow: i % 2 === 0 ? 0 : 0.4,
          ambientHue: 350,
          glowShown: true,
        }).glow,
      );
    }
    const changes = outputs.filter((g, i) => i > 0 && g !== outputs[i - 1]);
    expect(changes.length).toBeLessThan(outputs.length / 2);
    expect(outputs.slice(0, 5)).toEqual([0, 0.4, 0, 0.4, 0]);
  });

  it("lets motion resume once old reversals leave the window", () => {
    const governor = new MotionGovernor();
    for (let i = 0; i < 10; i++) {
      governor.step(i * 33, {
        hue: 200,
        glow: i % 2 ? 0.4 : 0,
        ambientHue: 350,
        glowShown: true,
      });
    }
    const held = governor.current!.glow;
    const next = held === 0 ? 0.4 : 0;
    expect(
      governor.step(1400, {
        hue: 200,
        glow: next,
        ambientHue: 350,
        glowShown: true,
      }).glow,
    ).toBe(next);
  });

  it("holds the rendered hue, not the ambient fallback, when ambient moves under a hold", () => {
    const governor = new MotionGovernor();
    const rendered: number[] = [];
    const explicit: boolean[] = [];
    for (let i = 0; i < 9; i++) {
      const ambientHue = i < 5 ? 350 : 300;
      const out = governor.step(i * 20, {
        hue: i < 5 && i % 2 === 0 ? null : 260,
        glow: 0,
        ambientHue,
        glowShown: true,
      });
      rendered.push(out.hue ?? ambientHue);
      explicit.push(out.hue !== null);
    }
    expect(rendered.slice(0, 5)).toEqual([350, 260, 350, 260, 350]);
    expect(rendered.slice(5)).toEqual([350, 350, 350, 350]);
    expect(explicit.slice(5)).toEqual([true, true, true, true]);
  });

  for (const [name, generator] of [
    ["glow square waves", square("glow")],
    ["hue square waves", square("hue")],
    ["hue and glow square waves together", both],
    ["random interleavings", chaos],
  ] as const) {
    it(`reserves forced drops at random instants and after the third reversal for ${name}`, () => {
      for (let seed = 1; seed <= 20; seed++) {
        const rand = mulberry32(seed);
        const candidates = generator(rand);
        const baseline = drive(new MotionGovernor(), candidates);
        const series = baseline.map((frame) => ({
          t: frame.t,
          value: renderCheckerFrame(
            SHIPPED_DORCAS_MODES,
            frame.hue,
            frame.glow,
          ).samples.get("light/glow/canvas")!.luminance,
        }));
        const reversals = zigzagReversals(series, 0.005, 1e-4);
        const third = reversals.find(
          (t, i) => i >= 2 && t - reversals[i - 2] < 1000,
        );
        const instants = [
          candidates[0].t + rand() * (candidates.at(-1)!.t - candidates[0].t),
        ];
        if (third !== undefined) instants.push(third + 0.001);
        for (const instant of instants) {
          const before = candidates.filter(({ t }) => t < instant);
          const previous = before.at(-1) ?? candidates[0];
          const forced = { ...previous, t: instant, glowShown: false };
          const frames = drive(new MotionGovernor(), [
            ...before,
            forced,
            ...candidates.filter(({ t }) => t >= instant),
          ]);
          for (const { name: ruleName, rule, max } of FLASH_RULES) {
            const report = checkFlashes(SHIPPED_DORCAS_MODES, frames, rule);
            expect(
              report.worst.count,
              `${name} seed ${seed} drop ${instant} ${ruleName} ${report.worst.channel}`,
            ).toBeLessThanOrEqual(max);
          }
          if (baseline[before.length - 1]?.glow > 0) {
            expect(
              frames
                .filter(({ t }) => t >= instant && t < instant + 2000)
                .every(({ glow }) => glow === 0),
            ).toBe(true);
          }
        }
      }
    }, 120_000);

    it(`keeps ${name} within 2 flashes per second for every element (seeded)`, () => {
      for (let seed = 1; seed <= 40; seed++) {
        const candidates = generator(mulberry32(seed));
        const frames = drive(new MotionGovernor(), candidates);
        for (const { name: ruleName, rule, max } of FLASH_RULES) {
          const report = checkFlashes(SHIPPED_DORCAS_MODES, frames, rule);
          expect(
            report.worst.count,
            `seed ${seed} ${ruleName} ${report.worst.channel}`,
          ).toBeLessThanOrEqual(max);
          expect(report.maxGlow).toBeLessThanOrEqual(MOTION_MAX_GLOW);
          expect(report.outOfGamut).toEqual([]);
        }
      }
    }, 120_000);
  }

  it("keeps 4 reversals a second at an opacity off its grid (chaos seed 72 at 5%)", () => {
    const frames = drive(new MotionGovernor(), chaos(mulberry32(72)));
    const report = checkFlashes(
      SHIPPED_DORCAS_MODES,
      frames,
      strictRule(
        [0.05],
        MOTION_DEAD_BAND + PIPELINE_TOLERANCE,
        MOTION_EXTREME_TOLERANCE,
      ),
    );
    expect(report.worst.count, report.worst.channel).toBeLessThanOrEqual(
      MAX_REVERSALS_PER_SECOND,
    );
  });

  it("keeps 4 reversals a second at an opacity off its grid (chaos seed 16 at 70%)", () => {
    const frames = drive(new MotionGovernor(), chaos(mulberry32(16)));
    const report = checkFlashes(
      SHIPPED_DORCAS_MODES,
      frames,
      strictRule(
        [0.7],
        MOTION_DEAD_BAND + PIPELINE_TOLERANCE,
        MOTION_EXTREME_TOLERANCE,
      ),
    );
    expect(report.worst.count, report.worst.channel).toBeLessThanOrEqual(
      MAX_REVERSALS_PER_SECOND,
    );
  });

  it("counts a glow that a sheet hides or reveals as a move", () => {
    const candidates = Array.from({ length: 60 }, (_, i) => ({
      t: i * 33,
      hue: 200,
      glow: MOTION_MAX_GLOW,
      ambientHue: 350,
      glowShown: i % 2 === 0,
    }));
    for (const { rule, max } of FLASH_RULES) {
      expect(
        checkFlashes(
          SHIPPED_DORCAS_MODES,
          drive(new MotionGovernor(), candidates),
          rule,
        ).worst.count,
      ).toBeLessThanOrEqual(max);
    }
  });

  it("always keeps room to hide the glow at any tick (seeded)", () => {
    const worst = () => {
      let count = 0;
      for (let seed = 1; seed <= 20; seed++) {
        const rand = mulberry32(seed);
        const candidates = chaos(rand).map((candidate) => ({
          ...candidate,
          glowShown: rand() < 0.85,
        }));
        const frames = drive(new MotionGovernor(), candidates);
        for (const { rule } of FLASH_RULES) {
          count = Math.max(
            count,
            checkFlashes(SHIPPED_DORCAS_MODES, frames, rule).worst.count,
          );
        }
      }
      return count;
    };
    expect(worst()).toBeLessThanOrEqual(MAX_REVERSALS_PER_SECOND);
  }, 120_000);

  it("keeps 4 reversals a second at every opacity, not only the grid (seeded)", () => {
    const rule = strictRule(
      DENSE_OPACITY_FRACTIONS,
      MOTION_DEAD_BAND + PIPELINE_TOLERANCE,
      MOTION_EXTREME_TOLERANCE,
    );
    for (const [name, generator] of [
      ["glow", square("glow")],
      ["hue", square("hue")],
      ["both", both],
      ["chaos", chaos],
    ] as const) {
      for (let seed = 1; seed <= 25; seed++) {
        const frames = drive(new MotionGovernor(), generator(mulberry32(seed)));
        const report = checkFlashes(SHIPPED_DORCAS_MODES, frames, rule);
        expect(
          report.worst.count,
          `${name} seed ${seed} ${report.worst.channel}`,
        ).toBeLessThanOrEqual(MAX_REVERSALS_PER_SECOND);
      }
    }
  }, 120_000);

  it("shows the adversarial inputs would flash without the governor", () => {
    const candidates = Array.from({ length: 60 }, (_, i) => ({
      t: i * 33,
      hue: 200,
      glow: i % 4 < 2 ? 0 : MOTION_MAX_GLOW,
      ambientHue: 350,
      glowShown: true,
    }));
    const raw = candidates.map(({ t, hue, glow }) => ({ t, hue, glow }));
    for (const { rule, max } of FLASH_RULES) {
      expect(
        checkFlashes(SHIPPED_DORCAS_MODES, raw, rule).worst.count,
      ).toBeGreaterThan(max);
      expect(
        checkFlashes(
          SHIPPED_DORCAS_MODES,
          drive(new MotionGovernor(), candidates),
          rule,
        ).worst.count,
      ).toBeLessThanOrEqual(max);
    }
  });

  describe("with a saturated-red palette", () => {
    const red: DorcasModePalette = {
      mode: "dark",
      canvas: "#000000",
      ink: "#cfc5cc",
      sidebarInkPercent: 4.3,
      glow: { l: 0.628, c: 0.2577, alpha: 1 },
      hueTokens: { line: { l: 0.628, c: 0.2577, alpha: 1 } },
    };
    const redModes = asCheckerModes([red]);

    it("renders a saturated red at the red hue", () => {
      expect(
        isSaturatedRed(oklchToRgb({ l: 0.628, c: 0.2577, h: 29.23 })),
      ).toBe(true);
      expect(redCapablePalette(red)).toBe(true);
    });

    it("bounds red reversals too", () => {
      const hues = [29.23, 29.23, 140, 29.23, 200, 29.23];
      for (let seed = 1; seed <= 20; seed++) {
        const rand = mulberry32(seed);
        const candidates: (MotionCandidate & { t: number })[] = [];
        let t = 0;
        for (let i = 0; i < 200; i++) {
          t += 10 + rand() * 30;
          candidates.push({
            t,
            hue: hues[Math.floor(rand() * hues.length)],
            glow: rand() * 0.4,
            ambientHue: 29.23,
            glowShown: true,
          });
        }
        const unguarded = checkFlashes(
          redModes,
          candidates.map((c) => ({ t: c.t, hue: c.hue!, glow: c.glow })),
          STRICT_FLASH_RULE,
        );
        expect(unguarded.worst.count).toBeGreaterThan(MAX_REVERSALS_PER_SECOND);
        const frames = drive(
          new MotionGovernor({ palettes: [red] }),
          candidates,
        );
        for (const { name, rule, max } of FLASH_RULES) {
          const report = checkFlashes(redModes, frames, rule);
          expect(
            report.worst.count,
            `seed ${seed} ${name} ${report.worst.channel}`,
          ).toBeLessThanOrEqual(max);
        }
      }
    });
  });
});
