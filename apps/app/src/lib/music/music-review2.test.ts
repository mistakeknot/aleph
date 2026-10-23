import { describe, expect, it, vi } from "vitest";
import { checkFlashes, type CheckerFrame } from "@/test/flash-checker";
import { FLASH_RULES, SHIPPED_DORCAS_MODES } from "@/test/music-motion-support";
import { MusicMotion } from "./music-motion";
import { MotionGovernor } from "./motion-governor";
import type { SignalFields } from "./signal-schema";

const fields = (beat = false, keyConfidence = 0): SignalFields => ({
  energy: 1,
  beat,
  keyConfidence,
  key: 2,
  keyMode: "major",
  beatEnv: 0,
  bpm: 120,
  bpmConfidence: 0,
  synthetic: false,
});

describe("round 2 rendered regressions", () => {
  it("spends exactly the reserved fourth reversal on a drop immediately after the third", () => {
    const governor = new MotionGovernor();
    const timeline: CheckerFrame[] = [];
    for (let i = 0; i <= 4; i++) {
      const out = governor.step(i * 100, {
        hue: 350,
        glow: i % 2 === 0 ? 0.4 : 0,
        ambientHue: 350,
        glowShown: true,
      });
      timeline.push({ t: i * 100, hue: out.hue ?? 350, glow: out.glow });
    }
    expect(
      checkFlashes(SHIPPED_DORCAS_MODES, timeline, FLASH_RULES[0].rule).worst
        .count,
    ).toBe(3);
    const dropAt = 400.001;
    const dropped = governor.step(dropAt, {
      hue: 350,
      glow: 0.4,
      ambientHue: 350,
      glowShown: false,
    });
    timeline.push({ t: dropAt, hue: dropped.hue ?? 350, glow: 0 });
    for (const { rule, max } of FLASH_RULES) {
      expect(
        checkFlashes(SHIPPED_DORCAS_MODES, timeline, rule).worst.count,
      ).toBeLessThanOrEqual(max);
    }
    for (let t = 401; t < dropAt + 2000; t += 1) {
      expect(
        governor.step(t, {
          hue: 350,
          glow: 0.4,
          ambientHue: 350,
          glowShown: t % 7 !== 0,
        }).glow,
      ).toBe(0);
    }
  });

  it("finishes the 350 to 305 degree ease while reserving a forced drop", () => {
    const motion = new MusicMotion();
    motion.setActive(true);
    motion.tick(0, 225);
    let out = motion.tick(0, 225);
    for (let t = 20; t < 6950; t += 33) {
      motion.receive(t, {
        ...fields(Math.floor(t / 33) % 15 === 0, 0.9),
        energy: 0.6,
        key: t < 4640 ? 0 : 11,
        keyMode: t < 4640 ? "major" : "minor",
      });
      out = motion.tick(t, 225);
    }
    expect(Math.abs((out.hue ?? 225) - 305)).toBeLessThan(0.5);
  });

  it.each(["sheet", "reduced-motion", "forced-colors"])(
    "%s drop at 7088 ms reserves the fourth reversal",
    (cause) => {
      const motion = new MusicMotion();
      motion.setActive(true);
      const timeline: CheckerFrame[] = [];
      for (let t = 0; t <= 10_000; t += 16) {
        const hidden = t >= 7088 && t < 7104;
        if (cause === "sheet") motion.setDorcasSheet(!hidden);
        else motion.setSuppressed(hidden);
        motion.receive(t, fields([6000, 6512, 7024].includes(t)));
        const out = motion.tick(t, 350);
        timeline.push({ t, hue: out.hue ?? 350, glow: hidden ? 0 : out.glow });
      }
      for (const { name, rule, max } of FLASH_RULES) {
        const report = checkFlashes(SHIPPED_DORCAS_MODES, timeline, rule);
        expect(
          report.worst.count,
          `${cause} ${name} ${report.worst.channel}`,
        ).toBeLessThanOrEqual(max);
      }
      expect(
        timeline
          .filter(({ t }) => t >= 7088 && t < 9088)
          .every(({ glow }) => glow === 0),
      ).toBe(true);
      expect(timeline.at(-1)!.glow).toBeGreaterThan(0);
    },
  );

  it.each([256, 512, 1024, 1536, 3072])(
    "disabling at %i ms takes at least two seconds to settle",
    (stop) => {
      const motion = new MusicMotion();
      motion.setActive(true);
      for (let t = 0; t < stop; t += 16) {
        motion.receive(t, fields(false, 0.9));
        motion.tick(t, 350);
      }
      motion.setActive(false);
      let settledAt = Infinity;
      for (let t = stop; t <= stop + 5000; t += 16) {
        if (motion.tick(t, 350).settled) {
          settledAt = t;
          break;
        }
      }
      expect(settledAt - stop).toBeGreaterThanOrEqual(2000);
      expect(settledAt - stop).toBeLessThan(5000);
    },
  );

  it("does no governor work at rest or for an unchanged settled request", () => {
    const governor = new MotionGovernor();
    const step = vi.spyOn(governor, "step");
    const motion = new MusicMotion(governor);
    motion.tick(0, 350);
    step.mockClear();
    for (let t = 16; t <= 1000; t += 16) motion.tick(t, 350);
    expect(step).not.toHaveBeenCalled();
    motion.setActive(true);
    for (let t = 1024; t < 20_000; t += 16) {
      motion.receive(t, fields());
      motion.tick(t, 350);
    }
    step.mockClear();
    for (let t = 20_000; t < 21_000; t += 16) {
      motion.receive(t, fields());
      motion.tick(t, 350);
    }
    expect(step).not.toHaveBeenCalled();
  });
});

const MEAN_BOUND = 0.12;

it("keeps governor CPU cost below 0.15 ms per changed step by median and below the aggregate mean bound", () => {
  const governor = new MotionGovernor();
  const batches = 9;
  const perBatch = 700;
  const step = (i: number) =>
    governor.step(i * 16, {
      hue: Math.floor(i / 16) % 360,
      ambientHue: 350,
      glow: Math.round((0.2 + 0.2 * Math.sin(i / 10)) * 200) / 200,
      glowShown: true,
    });
  for (let i = 0; i < 1000; i++) step(i);
  const means: number[] = [];
  let next = 1000;
  for (let b = 0; b < batches; b++) {
    const start = process.cpuUsage();
    for (let i = 0; i < perBatch; i++) step(next++);
    const cpu = process.cpuUsage(start);
    means.push((cpu.user + cpu.system) / 1000 / perBatch);
  }
  means.sort((x, y) => x - y);
  const median = means[Math.floor(batches / 2)];
  const mean = means.reduce((sum, value) => sum + value, 0) / batches;
  console.log(
    `Governor CPU ms/step: median ${median.toFixed(6)} mean ${mean.toFixed(6)} (${batches} batches of ${perBatch} changed requests)`,
  );
  expect(median).toBeLessThan(0.15);
  expect(mean).toBeLessThan(MEAN_BOUND);
}, 30_000);
