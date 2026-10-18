export const SIGNAL_SCHEMA_VERSION = 1;

export const SIGNAL_BPM_MIN = 40;
export const SIGNAL_BPM_MAX = 220;

export type SignalKeyMode = "major" | "minor";

export interface SignalFields {
  energy: number;
  beatEnv: number;
  bpmConfidence: number;
  keyConfidence: number;
  beat: boolean;
  synthetic: boolean;
  bpm: number;
  key: number;
  keyMode: SignalKeyMode;
}

export interface SignalFrameV1 extends SignalFields {
  v: 1;
  seq: number;
  t: number;
}

export const SIGNAL_FRAME_KEYS: readonly (keyof SignalFrameV1)[] = [
  "v",
  "seq",
  "t",
  "energy",
  "beatEnv",
  "bpmConfidence",
  "keyConfidence",
  "beat",
  "synthetic",
  "bpm",
  "key",
  "keyMode",
];

const UNIT_KEYS = [
  "energy",
  "beatEnv",
  "bpmConfidence",
  "keyConfidence",
] as const;

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

const fail = <T>(error: string): ValidationResult<T> => ({ ok: false, error });

function isPlainObject(x: unknown): x is Record<string, unknown> {
  if (typeof x !== "object" || x === null || Array.isArray(x)) return false;
  const proto = Object.getPrototypeOf(x);
  return proto === Object.prototype || proto === null;
}

const isFiniteNumber = (x: unknown): x is number =>
  typeof x === "number" && Number.isFinite(x);

export const SIGNAL_FIELD_KEYS: readonly (keyof SignalFields)[] =
  SIGNAL_FRAME_KEYS.filter(
    (k): k is keyof SignalFields => k !== "v" && k !== "seq" && k !== "t",
  );

function checkExactKeys(
  x: Record<string, unknown>,
  allowed: readonly string[],
): string | null {
  for (const k of Object.keys(x)) {
    if (!allowed.includes(k)) return `unexpected key "${k}"`;
  }
  for (const k of allowed) {
    if (!Object.prototype.hasOwnProperty.call(x, k))
      return `missing key "${k}"`;
  }
  return null;
}

function checkFieldValues(x: Record<string, unknown>): string | null {
  for (const k of UNIT_KEYS) {
    const val = x[k];
    if (!isFiniteNumber(val)) return `${k} must be a finite number`;
    if (val < 0 || val > 1) return `${k} must be in 0..1`;
  }

  if (typeof x.beat !== "boolean") return "beat must be a boolean";
  if (typeof x.synthetic !== "boolean") return "synthetic must be a boolean";

  if (!isFiniteNumber(x.bpm)) return "bpm must be a finite number";
  if (x.bpm !== 0 && (x.bpm < SIGNAL_BPM_MIN || x.bpm > SIGNAL_BPM_MAX))
    return "bpm must be 0 or in 40..220";

  if (
    !Number.isInteger(x.key) ||
    (x.key as number) < 0 ||
    (x.key as number) > 11
  )
    return "key must be an integer in 0..11";

  if (x.keyMode !== "major" && x.keyMode !== "minor")
    return 'keyMode must be "major" or "minor"';

  return null;
}

export function validateSignalFields(
  x: unknown,
): ValidationResult<SignalFields> {
  if (!isPlainObject(x)) return fail("fields are not a plain object");
  const err = checkExactKeys(x, SIGNAL_FIELD_KEYS) ?? checkFieldValues(x);
  return err ? fail(err) : { ok: true, value: x as unknown as SignalFields };
}

export function validateSignalFrame(
  x: unknown,
): ValidationResult<SignalFrameV1> {
  if (!isPlainObject(x)) return fail("frame is not a plain object");
  const keyErr = checkExactKeys(x, SIGNAL_FRAME_KEYS);
  if (keyErr) return fail(keyErr);

  if (x.v !== SIGNAL_SCHEMA_VERSION) return fail("v must be the integer 1");

  if (!Number.isSafeInteger(x.seq) || (x.seq as number) < 0)
    return fail("seq must be an integer in 0..2^53-1");

  if (!isFiniteNumber(x.t) || x.t < 0)
    return fail("t must be a finite number >= 0");

  const err = checkFieldValues(x);
  return err ? fail(err) : { ok: true, value: x as unknown as SignalFrameV1 };
}

export class SignalSequenceChecker {
  private lastSeq = -1;
  private lastT = -Infinity;

  check(frame: SignalFrameV1): ValidationResult<SignalFrameV1> {
    if (frame.seq !== this.lastSeq + 1)
      return fail(`seq must be ${this.lastSeq + 1}, got ${frame.seq}`);
    if (frame.t < this.lastT) return fail("t must be non-decreasing");
    this.lastSeq = frame.seq;
    this.lastT = frame.t;
    return { ok: true, value: frame };
  }

  get nextSeq(): number {
    return this.lastSeq + 1;
  }
}

export function acceptSignalFrame(
  x: unknown,
  checker: SignalSequenceChecker,
): ValidationResult<SignalFrameV1> {
  const r = validateSignalFrame(x);
  return r.ok ? checker.check(r.value) : r;
}
