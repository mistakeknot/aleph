import { describe, expect, it } from "vitest";
import {
  checkerChromaticity,
  checkerLuminance,
  checkerSample,
  checkerSaturatedRed,
  checkerUvDistance,
  checkSampleFlashes,
  strictRule,
  WCAG_FLASH_RULE,
  type CheckerSampleFrame,
} from "./flash-checker";

type Srgb = readonly [number, number, number];

const SATURATED_RED: Srgb = [1, 0, 0.5];
const EQUAL_LUMINANCE_OLIVE: Srgb = [0.5329, 0.5329, 0];

function alternate(
  first: Srgb,
  second: Srgb,
  periodMs: number,
  count: number,
): CheckerSampleFrame[] {
  return Array.from({ length: count }, (_, i) => ({
    t: i * periodMs,
    samples: new Map([
      ["element", checkerSample(i % 2 === 0 ? first : second)],
    ]),
  }));
}

describe("flash checker red transitions", () => {
  it("measures the WCAG pair at equal luminance with one saturated red endpoint", () => {
    expect(checkerSaturatedRed(SATURATED_RED)).toBe(true);
    expect(checkerSaturatedRed(EQUAL_LUMINANCE_OLIVE)).toBe(false);
    expect(
      Math.abs(
        checkerLuminance(SATURATED_RED) -
          checkerLuminance(EQUAL_LUMINANCE_OLIVE),
      ),
    ).toBeLessThan(1e-3);
    expect(
      checkerUvDistance(
        checkerChromaticity(SATURATED_RED),
        checkerChromaticity(EQUAL_LUMINANCE_OLIVE),
      ),
    ).toBeCloseTo(0.218, 3);
  });

  it("counts every opposing transition between endpoints 0.218 apart in u′v′ as a red flash", () => {
    const frames = alternate(SATURATED_RED, EQUAL_LUMINANCE_OLIVE, 100, 11);
    const report = checkSampleFlashes(frames, WCAG_FLASH_RULE);
    expect(report.counts.get("element/luminance")).toBe(0);
    expect(report.counts.get("element/red")).toBeGreaterThanOrEqual(9);
  });

  it("ignores the same chromaticity swing when neither endpoint is saturated red", () => {
    const olive: Srgb = [0.5329, 0.5329, 0];
    const violet: Srgb = [0.6, 0.35, 0.9];
    const frames = alternate(olive, violet, 100, 11);
    for (const rule of [WCAG_FLASH_RULE, strictRule([1], 0.005, 1e-4)]) {
      const report = checkSampleFlashes(frames, rule);
      expect(report.counts.get("element/red")).toBe(0);
    }
  });

  it("does not fade chromaticity near black", () => {
    const dimRed: Srgb = [0.05, 0, 0];
    const dimBlue: Srgb = [0, 0, 0.05];
    expect(checkerLuminance(dimRed)).toBeLessThan(0.01);
    const frames = alternate(dimRed, dimBlue, 100, 11);
    const report = checkSampleFlashes(frames, WCAG_FLASH_RULE);
    expect(report.counts.get("element/red")).toBeGreaterThanOrEqual(9);
  });

  it("counts strict red reversals between nearby chromaticities around a saturated red", () => {
    const red: Srgb = [1, 0, 0];
    const pinker: Srgb = [1, 0, 0.2];
    const frames = alternate(red, pinker, 100, 11);
    const report = checkSampleFlashes(frames, strictRule([1], 0.005, 1e-4));
    expect(report.counts.get("element/luminance")).toBe(0);
    expect(report.counts.get("element/red")).toBeGreaterThanOrEqual(9);
  });
});
