import { describe, expect, it } from "vitest";
import { checkFlashes, type CheckerFrame } from "@/test/flash-checker";
import {
  FLASH_RULES,
  mulberry32,
  SHIPPED_DORCAS_MODES,
} from "@/test/music-motion-support";
import { hueArc, normalizeHue } from "./dorcas-colors";
import { MOTION_MAX_GLOW } from "./motion-governor";
import {
  ambientHueFor,
  ENERGY_TAU_MS,
  HUE_EASE_MS,
  HUE_MIN_STEP_DEGREES,
  HUE_RELEASE_EASE_MS,
  HUE_WRITE_INTERVAL_MS,
  KEY_RELEASE_AFTER_MS,
  keyHue,
  MUSIC_FADE_MS,
  MUSIC_FRESH_MS,
  MusicMotion,
  PULSE_GLOW_GAIN,
  PULSE_MAX_PER_WINDOW,
  PULSE_RISE_MS,
  PULSE_WINDOW_MS,
  REST_GLOW_MAX,
} from "./music-motion";
import type { SignalFields, SignalKeyMode } from "./signal-schema";

const frame = (over: Partial<SignalFields> = {}): SignalFields => ({
  energy: 0,
  beatEnv: 0,
  bpmConfidence: 0,
  keyConfidence: 0,
  beat: false,
  synthetic: false,
  bpm: 120,
  key: 0,
  keyMode: "major",
  ...over,
});

interface Tick {
  t: number;
  ambient: number;
  frame?: SignalFields;
  active?: boolean;
  suppressed?: boolean;
  rest?: boolean;
}

interface Output {
  t: number;
  ambient: number;
  hue: number | null;
  glow: number;
  settled: boolean;
}

function run(ticks: readonly Tick[], motion = new MusicMotion()): Output[] {
  return ticks.map((tick) => {
    if (tick.active !== undefined) motion.setActive(tick.active);
    if (tick.suppressed !== undefined) motion.setSuppressed(tick.suppressed);
    if (tick.rest !== undefined) motion.setRest(tick.rest);
    if (tick.frame) motion.receive(tick.t, tick.frame);
    return {
      t: tick.t,
      ambient: tick.ambient,
      ...motion.tick(tick.t, tick.ambient),
    };
  });
}

const rendered = (outputs: readonly Output[]): CheckerFrame[] =>
  outputs.map((o) => ({ t: o.t, hue: o.hue ?? o.ambient, glow: o.glow }));

const shown = (o: Output): number => o.hue ?? o.ambient;

function steady(
  fromMs: number,
  toMs: number,
  ambient: number,
  fields: Partial<SignalFields> | null,
  intervalMs = 20,
): Tick[] {
  const out: Tick[] = [];
  for (let t = fromMs; t < toMs; t += intervalMs) {
    out.push({ t, ambient, frame: fields ? frame(fields) : undefined });
  }
  return out;
}

const at = (outputs: readonly Output[], t: number): Output => {
  const found = [...outputs].reverse().find((o) => o.t <= t);
  if (!found) throw new Error(`no output at ${t}`);
  return found;
};

function expectNear(output: Output, hue: number): void {
  expect(output.hue).not.toBeNull();
  expect(Math.abs(hueArc(output.hue!, hue))).toBeLessThan(HUE_MIN_STEP_DEGREES);
}

const KEY_STATES: { key: number; keyMode: SignalKeyMode }[] = [
  ...Array.from({ length: 12 }, (_, key) => ({
    key,
    keyMode: "major" as const,
  })),
  ...Array.from({ length: 12 }, (_, key) => ({
    key,
    keyMode: "minor" as const,
  })),
];

function eulerianCircuit(n: number): number[] {
  const next = Array.from({ length: n }, (_, v) =>
    Array.from({ length: n }, (_, w) => w).filter((w) => w !== v),
  );
  const stack = [0];
  const circuit: number[] = [];
  while (stack.length > 0) {
    const v = stack[stack.length - 1];
    const w = next[v].pop();
    if (w === undefined) circuit.push(stack.pop()!);
    else stack.push(w);
  }
  return circuit.reverse();
}

function expectFlashSafe(outputs: readonly Output[], label: string): void {
  const frames = rendered(outputs);
  for (const { name, rule, max } of FLASH_RULES) {
    const report = checkFlashes(SHIPPED_DORCAS_MODES, frames, rule);
    expect(
      report.worst.count,
      `${label} ${name} ${report.worst.channel}`,
    ).toBeLessThanOrEqual(max);
    expect(report.maxGlow).toBeLessThanOrEqual(MOTION_MAX_GLOW);
  }
}

function expectHueWritesPaced(outputs: readonly Output[], label: string): void {
  const writes: number[] = [];
  for (let i = 1; i < outputs.length; i++) {
    const before = outputs[i - 1].hue;
    const after = outputs[i].hue;
    if (before === after) continue;
    writes.push(outputs[i].t);
    if (before !== null && after !== null) {
      expect(
        Math.abs(hueArc(before, after)),
        `${label} step at ${outputs[i].t}`,
      ).toBeGreaterThanOrEqual(HUE_MIN_STEP_DEGREES);
    }
  }
  for (let i = 1; i < writes.length; i++) {
    expect(
      writes[i] - writes[i - 1],
      `${label} write at ${writes[i]}`,
    ).toBeGreaterThanOrEqual(HUE_WRITE_INTERVAL_MS);
  }
}

type BeatPattern = (i: number, rand: () => number) => boolean;
type EnergyPattern = (t: number, i: number, rand: () => number) => number;

const BEAT_PATTERNS: BeatPattern[] = [
  () => true,
  (i) => i % 2 === 0,
  (i) => i % 12 < 4,
  (_, rand) => rand() < 0.3,
  () => false,
];

const ENERGY_PATTERNS: ((rand: () => number) => EnergyPattern)[] = [
  () => (_, i) => (i % 2 === 0 ? 0 : 1),
  (rand) => {
    const hz = 2 + rand() * 8;
    return (t) => (Math.floor((t * hz * 2) / 1000) % 2 === 0 ? 0 : 1);
  },
  () => (_, __, rand) => rand(),
  (rand) => {
    const level = rand();
    return () => level;
  },
];

function chaosScenario(rand: () => number): Tick[] {
  const ticks: Tick[] = [];
  let t = 0;
  let ambient = ambientHueFor(rand());
  let staleUntil = 0;
  let beat: BeatPattern = BEAT_PATTERNS[0];
  let energy: EnergyPattern = ENERGY_PATTERNS[0](rand);
  let state = KEY_STATES[0];
  let confidence = (_: number) => 0.9;
  let segmentEnds = 0;
  for (let i = 0; i < 1500; i++) {
    t += rand() < 0.05 ? 0 : 8 + rand() * 42;
    if (t >= segmentEnds) {
      segmentEnds = t + 500 + rand() * 3500;
      beat = BEAT_PATTERNS[Math.floor(rand() * BEAT_PATTERNS.length)];
      energy =
        ENERGY_PATTERNS[Math.floor(rand() * ENERGY_PATTERNS.length)](rand);
      state = KEY_STATES[Math.floor(rand() * KEY_STATES.length)];
      const kind = Math.floor(rand() * 4);
      confidence =
        kind === 0
          ? () => 0.9
          : kind === 1
            ? (n) => (n % 2 === 0 ? 0.3 : 0.6)
            : kind === 2
              ? (n) => (n % 2 === 0 ? 0.35 : 0.45)
              : () => rand();
      if (rand() < 0.2) staleUntil = t + 1000 + rand() * 4000;
    }
    if (rand() < 0.02) ambient = normalizeHue(ambient - 7);
    if (rand() < 0.005) ambient = rand() * 360;
    const tick: Tick = { t, ambient };
    if (rand() < 0.01) tick.active = rand() < 0.8;
    if (rand() < 0.01) tick.suppressed = rand() < 0.3;
    if (rand() < 0.01) tick.rest = rand() < 0.4;
    if (t >= staleUntil && rand() < 0.85) {
      const hop = rand() < 0.05;
      const current = hop
        ? KEY_STATES[Math.floor(rand() * KEY_STATES.length)]
        : state;
      tick.frame = frame({
        energy: energy(t, i, rand),
        keyConfidence: confidence(i),
        beat: beat(i, rand),
        synthetic: rand() < 0.05,
        key: current.key,
        keyMode: current.keyMode,
      });
    }
    ticks.push(tick);
  }
  ticks[0].active = true;
  return ticks;
}

describe("keyHue", () => {
  it("maps keys onto the Dorcas wheel with minor keys 15 degrees lower", () => {
    expect(keyHue(0, "major")).toBe(350);
    expect(keyHue(1, "major")).toBe(20);
    expect(keyHue(11, "major")).toBe(320);
    expect(keyHue(0, "minor")).toBe(335);
    expect(keyHue(9, "minor")).toBe(245);
  });

  it("matches the ambient wave's endpoints", () => {
    expect(ambientHueFor(0)).toBe(350);
    expect(ambientHueFor(1)).toBe(225);
  });
});

describe("MusicMotion", () => {
  const AMBIENT = 225;

  it("stays out of the way until it is active and receiving frames", () => {
    const motion = new MusicMotion();
    const idle = run(
      steady(0, 3000, AMBIENT, { keyConfidence: 0.9, energy: 1, beat: true }),
      motion,
    );
    expect(idle.every((o) => o.hue === null && o.glow === 0 && o.settled)).toBe(
      true,
    );
  });

  it("ignores synthetic frames entirely", () => {
    const outputs = run([
      { t: 0, ambient: AMBIENT, active: true },
      ...steady(20, 6000, AMBIENT, {
        synthetic: true,
        keyConfidence: 0.9,
        key: 4,
        energy: 1,
        beat: true,
      }),
    ]);
    expect(
      outputs.every((o) => o.hue === null && o.glow === 0 && o.settled),
    ).toBe(true);
  });

  it("eases to a confident key over at least 2 s", () => {
    const target = keyHue(3, "major");
    const outputs = run([
      { t: 0, ambient: AMBIENT, active: true },
      ...steady(20, 4000, AMBIENT, { keyConfidence: 0.9, key: 3 }),
    ]);
    expect(Math.abs(hueArc(shown(at(outputs, 1500)), target))).toBeGreaterThan(
      HUE_MIN_STEP_DEGREES,
    );
    expect(
      Math.abs(hueArc(shown(at(outputs, HUE_EASE_MS + 400)), target)),
    ).toBeLessThan(HUE_MIN_STEP_DEGREES);
    expectHueWritesPaced(outputs, "engage");
  });

  it("moves B to C along the 30 degree arc", () => {
    const outputs = run([
      { t: 0, ambient: AMBIENT, active: true },
      ...steady(20, 3000, AMBIENT, { keyConfidence: 0.9, key: 11 }),
      ...steady(3000, 6000, AMBIENT, { keyConfidence: 0.9, key: 0 }),
    ]);
    const path = outputs.filter((o) => o.t >= 3000).map(shown);
    for (let i = 1; i < path.length; i++) {
      expect(hueArc(path[i - 1], path[i])).toBeGreaterThanOrEqual(0);
    }
    for (const hue of path) {
      expect(hueArc(320, hue)).toBeGreaterThanOrEqual(-HUE_MIN_STEP_DEGREES);
      expect(hueArc(hue, 350)).toBeGreaterThanOrEqual(-HUE_MIN_STEP_DEGREES);
    }
    expect(Math.abs(hueArc(path[path.length - 1], 350))).toBeLessThan(
      HUE_MIN_STEP_DEGREES,
    );
  });

  it("does not flicker when confidence oscillates around the thresholds", () => {
    for (const levels of [
      [0.35, 0.45],
      [0.3, 0.6],
      [0.39, 0.55],
    ]) {
      const ticks: Tick[] = [
        { t: 0, ambient: AMBIENT, active: true },
        ...steady(20, 3000, AMBIENT, { keyConfidence: 0.9, key: 5 }),
      ];
      for (let i = 0, t = 3000; t < 13000; i++, t += 20) {
        ticks.push({
          t,
          ambient: AMBIENT,
          frame: frame({ keyConfidence: levels[i % 2], key: 5 }),
        });
      }
      const outputs = run(ticks).filter((o) => o.t >= 3000);
      expect(new Set(outputs.map((o) => o.hue)).size).toBe(1);
      expect(outputs[0].hue).toBe(keyHue(5, "major"));
    }
  });

  it("lets a hue ease finish before turning around", () => {
    const ticks: Tick[] = [{ t: 0, ambient: AMBIENT, active: true }];
    for (let i = 0, t = 20; t < 20000; i++, t += 20) {
      ticks.push({
        t,
        ambient: AMBIENT,
        frame: frame({ keyConfidence: 0.9, key: i % 2 === 0 ? 2 : 7 }),
      });
    }
    const outputs = run(ticks).filter((o) => o.t >= MUSIC_FADE_MS);
    let direction = 0;
    let turnedAt = -Infinity;
    for (let i = 1; i < outputs.length; i++) {
      const step = Math.sign(hueArc(shown(outputs[i - 1]), shown(outputs[i])));
      if (step === 0) continue;
      if (direction !== 0 && step !== direction) {
        expect(outputs[i].t - turnedAt).toBeGreaterThanOrEqual(
          HUE_EASE_MS - HUE_WRITE_INTERVAL_MS,
        );
        turnedAt = outputs[i].t;
      }
      direction = step;
    }
    expect(turnedAt).toBeGreaterThan(0);
  });

  it("releases a key after 3 s of low confidence and eases home over 4 s", () => {
    const target = keyHue(8, "minor");
    const outputs = run([
      { t: 0, ambient: AMBIENT, active: true },
      ...steady(20, 5000, AMBIENT, {
        keyConfidence: 0.9,
        key: 8,
        keyMode: "minor",
      }),
      ...steady(5000, 16000, AMBIENT, { keyConfidence: 0.2 }),
    ]);
    expectNear(at(outputs, 5000 + KEY_RELEASE_AFTER_MS - 40), target);
    const midway = shown(at(outputs, 5000 + KEY_RELEASE_AFTER_MS + 2000));
    expect(Math.abs(hueArc(midway, target))).toBeGreaterThan(1);
    expect(Math.abs(hueArc(midway, AMBIENT))).toBeGreaterThan(1);
    const home = at(
      outputs,
      5000 +
        KEY_RELEASE_AFTER_MS +
        HUE_RELEASE_EASE_MS +
        2 * HUE_WRITE_INTERVAL_MS,
    );
    expect(home.hue).toBeNull();
  });

  it("accepts at most 2 beats per second and none during a rise", () => {
    const motion = new MusicMotion();
    motion.setActive(true);
    const onsets: number[] = [];
    let previous = 0;
    let rising = false;
    for (let t = 0; t < 5000; t++) {
      if (t % 16 === 0) motion.receive(t, frame({ beat: true }));
      const pulse = motion.pulse(t);
      const nowRising = pulse > previous;
      if (nowRising && !rising) onsets.push(t);
      rising = nowRising;
      previous = pulse;
    }
    expect(onsets.length).toBeGreaterThanOrEqual(8);
    for (let i = 0; i < onsets.length; i++) {
      const inWindow = onsets.filter(
        (o) => o > onsets[i] - PULSE_WINDOW_MS && o <= onsets[i],
      );
      expect(inWindow.length).toBeLessThanOrEqual(PULSE_MAX_PER_WINDOW);
      if (i > 0) {
        expect(onsets[i] - onsets[i - 1]).toBeGreaterThanOrEqual(PULSE_RISE_MS);
      }
    }
  });

  it("peaks at most 0.4 with full energy and pulses", () => {
    const resting = run([
      { t: 0, ambient: AMBIENT, active: true },
      ...steady(20, 12000, AMBIENT, { energy: 1 }),
    ]);
    const ticks: Tick[] = [{ t: 0, ambient: AMBIENT, active: true }];
    for (let t = 20; t < 12000; t += 20) {
      ticks.push({
        t,
        ambient: AMBIENT,
        frame: frame({ energy: 1, beat: t % 500 === 0 }),
      });
    }
    const peak = Math.max(...run(ticks).map((o) => o.glow));
    expect(peak).toBeLessThanOrEqual(MOTION_MAX_GLOW);
    expect(peak).toBeGreaterThanOrEqual(REST_GLOW_MAX + PULSE_GLOW_GAIN - 0.02);
    expect(Math.max(...resting.map((o) => o.glow))).toBeCloseTo(
      REST_GLOW_MAX,
      2,
    );
  });

  it("smooths energy with a 1.5 s time constant and shows no glow at zero", () => {
    const outputs = run([
      { t: 0, ambient: AMBIENT, active: true },
      ...steady(20, 3000, AMBIENT, { energy: 0 }),
      ...steady(3000, 12000, AMBIENT, { energy: 1 }),
    ]);
    expect(outputs.filter((o) => o.t < 3000).every((o) => o.glow === 0)).toBe(
      true,
    );
    const expected = REST_GLOW_MAX * (1 - Math.exp(-1));
    expect(
      Math.abs(at(outputs, 3000 + ENERGY_TAU_MS).glow - expected),
    ).toBeLessThan(0.006);
  });

  it("turns the glow off at rest while the hue still follows the music", () => {
    const ticks: Tick[] = [
      { t: 0, ambient: AMBIENT, active: true, rest: true },
    ];
    for (let t = 20; t < 6000; t += 20) {
      ticks.push({
        t,
        ambient: AMBIENT,
        frame: frame({
          energy: 1,
          beat: t % 500 === 0,
          keyConfidence: 0.9,
          key: 6,
        }),
      });
    }
    const outputs = run(ticks);
    expect(outputs.every((o) => o.glow === 0)).toBe(true);
    expectNear(at(outputs, 5900), keyHue(6, "major"));
  });

  it("holds for 1.5 s after the last frame, then fades home over 2 s", () => {
    const target = keyHue(2, "major");
    const ticks: Tick[] = [
      { t: 0, ambient: AMBIENT, active: true },
      ...steady(20, 5000, AMBIENT, { energy: 1, keyConfidence: 0.9, key: 2 }),
      ...steady(5000, 12000, AMBIENT, null),
    ];
    const outputs = run(ticks);
    const last = 4980;
    expectNear(at(outputs, last + MUSIC_FRESH_MS - 20), target);
    expect(at(outputs, last + MUSIC_FRESH_MS - 20).glow).toBeGreaterThan(0.1);
    const fading = at(outputs, last + MUSIC_FRESH_MS + MUSIC_FADE_MS / 2);
    expect(Math.abs(hueArc(shown(fading), target))).toBeGreaterThan(1);
    expect(fading.glow).toBeLessThan(0.1);
    const home = at(
      outputs,
      last + MUSIC_FRESH_MS + MUSIC_FADE_MS + 2 * HUE_WRITE_INTERVAL_MS,
    );
    expect(home).toMatchObject({ hue: null, glow: 0, settled: true });
  });

  it("drops to ambient at once when suppressed and ignores frames while inactive", () => {
    const outputs = run([
      { t: 0, ambient: AMBIENT, active: true },
      ...steady(20, 5000, AMBIENT, { energy: 1, keyConfidence: 0.9, key: 2 }),
      {
        t: 5000,
        ambient: AMBIENT,
        suppressed: true,
        frame: frame({ energy: 1, keyConfidence: 0.9, key: 2 }),
      },
      ...steady(5020, 6000, AMBIENT, { energy: 1, keyConfidence: 0.9, key: 2 }),
      { t: 6000, ambient: AMBIENT, suppressed: false, active: false },
      ...steady(6020, 12000, AMBIENT, {
        energy: 1,
        keyConfidence: 0.9,
        key: 2,
      }),
    ]);
    const suppressed = at(outputs, 5000);
    expect(shown(suppressed)).toBe(AMBIENT);
    expect(suppressed.glow).toBe(0);
    expect(at(outputs, 5000 + 2 * HUE_WRITE_INTERVAL_MS).hue).toBeNull();
    expect(
      outputs
        .filter((o) => o.t >= 6000)
        .every((o) => o.hue === null && o.glow === 0),
    ).toBe(true);
  });

  describe("under the independent flash checker", () => {
    it("keeps every ordered pair of the 24 key states flash-safe and on the short arc", () => {
      const circuit = eulerianCircuit(KEY_STATES.length);
      expect(circuit.length).toBe(
        KEY_STATES.length * (KEY_STATES.length - 1) + 1,
      );
      const holdMs = HUE_EASE_MS + 300;
      const ticks: Tick[] = [{ t: 0, ambient: AMBIENT, active: true }];
      const switches: { t: number; from: number; to: number }[] = [];
      let t = 20;
      for (let i = 0; i < circuit.length; i++) {
        const state = KEY_STATES[circuit[i]];
        if (i > 0) {
          switches.push({
            t,
            from: keyHue(
              KEY_STATES[circuit[i - 1]].key,
              KEY_STATES[circuit[i - 1]].keyMode,
            ),
            to: keyHue(state.key, state.keyMode),
          });
        }
        for (
          const end = t + (i === 0 ? 2 * holdMs : holdMs);
          t < end;
          t += 33
        ) {
          ticks.push({
            t,
            ambient: AMBIENT,
            frame: frame({
              ...state,
              keyConfidence: 0.9,
              energy: 0.6,
              beat: Math.floor(t / 33) % 15 === 0,
            }),
          });
        }
      }
      const outputs = run(ticks);
      expectFlashSafe(outputs, "key pairs");
      expectHueWritesPaced(outputs, "key pairs");
      for (const [index, { t: start, from, to }] of switches.entries()) {
        const end = switches[index + 1]?.t ?? Infinity;
        const leg = outputs.filter((o) => o.t >= start && o.t < end);
        const span = Math.abs(hueArc(from, to));
        for (const o of leg) {
          const h = shown(o);
          expect(
            Math.abs(hueArc(from, h)) + Math.abs(hueArc(h, to)),
            `${from}->${to} at ${o.t}`,
          ).toBeLessThanOrEqual(span + 2 * HUE_MIN_STEP_DEGREES);
        }
        expect(
          Math.abs(hueArc(shown(leg[leg.length - 1]), to)),
          `${from}->${to} settles`,
        ).toBeLessThan(HUE_MIN_STEP_DEGREES);
      }
    }, 120_000);

    it("keeps every key state flash-safe to and from the ambient path", () => {
      const ticks: Tick[] = [{ t: 0, ambient: AMBIENT, active: true }];
      let t = 20;
      let ambientWave = 0;
      for (const state of KEY_STATES) {
        ambientWave = (ambientWave + 0.37) % 1;
        const ambient = ambientHueFor(ambientWave);
        for (const end = t + 3000; t < end; t += 33) {
          ticks.push({
            t,
            ambient,
            frame: frame({ ...state, keyConfidence: 0.9, energy: 0.8 }),
          });
        }
        for (
          const end = t + KEY_RELEASE_AFTER_MS + HUE_RELEASE_EASE_MS + 500;
          t < end;
          t += 33
        ) {
          ticks.push({
            t,
            ambient,
            frame: frame({ ...state, keyConfidence: 0.2, energy: 0.8 }),
          });
        }
      }
      const outputs = run(ticks);
      expectFlashSafe(outputs, "ambient path");
      expectHueWritesPaced(outputs, "ambient path");
    });

    it("keeps random interleavings of every input flash-safe (seeded)", () => {
      for (let seed = 1; seed <= 30; seed++) {
        const outputs = run(chaosScenario(mulberry32(seed)));
        expectFlashSafe(outputs, `seed ${seed}`);
        expectHueWritesPaced(outputs, `seed ${seed}`);
      }
    }, 120_000);
  });
});
