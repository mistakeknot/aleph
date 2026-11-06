const MIB = 1024 * 1024;

export const PLACEHOLDER_MAX_ENCODED_BYTES = 16 * 1024;
export const OVERSIZED_REASON = "record_too_large";

export interface AdmissionLimits {
  maxBatchInputBytes: number;
  maxBatchAccountedBytes: number;
  maxDepth: number;
  valueAllowanceBytes: number;
}

export const DEFAULT_ADMISSION_LIMITS: AdmissionLimits = {
  maxBatchInputBytes: 4 * MIB,
  maxBatchAccountedBytes: 16 * MIB,
  maxDepth: 32,
  valueAllowanceBytes: 128,
};

export type MeasureResult =
  | { ok: true; inputBytes: number; accountedBytes: number }
  | {
      ok: false;
      limit: "input_bytes" | "accounted_bytes" | "depth";
      message: string;
      inputBytes: number;
      accountedBytes: number;
    };

class Exceeded extends Error {
  readonly limit: "input_bytes" | "accounted_bytes" | "depth";

  constructor(limit: "input_bytes" | "accounted_bytes" | "depth") {
    super(limit);
    this.limit = limit;
  }
}

export function measureValue(
  root: unknown,
  limits: AdmissionLimits = DEFAULT_ADMISSION_LIMITS,
): MeasureResult {
  let input = 0;
  let accounted = 0;

  const charge = (accountedBytes: number, inputBytes: number): void => {
    accounted += accountedBytes;
    input += inputBytes;
    if (accounted > limits.maxBatchAccountedBytes) {
      throw new Exceeded("accounted_bytes");
    }
    if (input > limits.maxBatchInputBytes) throw new Exceeded("input_bytes");
  };

  const chargeString = (value: string): void => {
    const units = value.length;
    if (units * 2 + accounted > limits.maxBatchAccountedBytes) {
      throw new Exceeded("accounted_bytes");
    }
    if (units > limits.maxBatchInputBytes) throw new Exceeded("input_bytes");
    const utf8 = Buffer.byteLength(value, "utf8");
    charge(Math.max(utf8, units * 2), utf8);
  };

  const visit = (value: unknown, depth: number): void => {
    charge(limits.valueAllowanceBytes, 0);
    if (typeof value === "string") {
      chargeString(value);
      return;
    }
    if (typeof value === "number" || typeof value === "bigint") {
      charge(0, 8);
      return;
    }
    if (typeof value === "boolean") {
      charge(0, 1);
      return;
    }
    if (value === null || value === undefined) return;
    if (ArrayBuffer.isView(value)) {
      charge(value.byteLength, value.byteLength);
      return;
    }
    if (typeof value !== "object") return;
    if (depth + 1 > limits.maxDepth) throw new Exceeded("depth");
    if (Array.isArray(value)) {
      if (
        value.length * limits.valueAllowanceBytes + accounted >
        limits.maxBatchAccountedBytes
      ) {
        throw new Exceeded("accounted_bytes");
      }
      for (let index = 0; index < value.length; index += 1) {
        visit(value[index], depth + 1);
      }
      return;
    }
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      charge(limits.valueAllowanceBytes, 0);
      chargeString(key);
      visit(record[key], depth + 1);
    }
  };

  try {
    visit(root, 0);
  } catch (error) {
    if (!(error instanceof Exceeded)) throw error;
    const detail =
      error.limit === "depth"
        ? `nesting deeper than ${limits.maxDepth}`
        : error.limit === "input_bytes"
          ? `input exceeds ${limits.maxBatchInputBytes} bytes`
          : `accounted size exceeds ${limits.maxBatchAccountedBytes} bytes`;
    return {
      ok: false,
      limit: error.limit,
      message: detail,
      inputBytes: input,
      accountedBytes: accounted,
    };
  }
  return { ok: true, inputBytes: input, accountedBytes: accounted };
}

export interface OversizedPlaceholder {
  kind: "oversized_record";
  dedupeKey: string;
  startOffset: number;
  endOffset: number;
  byteLength: number;
  reason: typeof OVERSIZED_REASON;
}

export function oversizedDedupeKey(
  generation: number,
  startOffset: number,
): string {
  return `oversized:${generation}:${startOffset}`;
}

export function validatePlaceholder(
  placeholder: OversizedPlaceholder,
  source: { key: string; generation: number },
): string | null {
  if (typeof placeholder !== "object" || placeholder === null) {
    return "placeholder must be an object";
  }
  if (placeholder.kind !== "oversized_record") {
    return "placeholder kind must be oversized_record";
  }
  if (placeholder.reason !== OVERSIZED_REASON) {
    return `placeholder reason must be ${OVERSIZED_REASON}`;
  }
  const { startOffset, endOffset, byteLength } = placeholder;
  if (
    !Number.isSafeInteger(startOffset) ||
    !Number.isSafeInteger(endOffset) ||
    !Number.isSafeInteger(byteLength) ||
    startOffset < 0 ||
    endOffset <= startOffset ||
    byteLength !== endOffset - startOffset
  ) {
    return "placeholder offsets must be safe integers with byteLength equal to endOffset - startOffset";
  }
  if (
    placeholder.dedupeKey !== oversizedDedupeKey(source.generation, startOffset)
  ) {
    return "placeholder dedupeKey must be derived from the source generation and start offset";
  }
  const encoded = Buffer.byteLength(
    JSON.stringify({
      source: source.key,
      generation: source.generation,
      placeholder,
    }),
    "utf8",
  );
  if (encoded > PLACEHOLDER_MAX_ENCODED_BYTES) {
    return `placeholder encodes to ${encoded} bytes; limit is ${PLACEHOLDER_MAX_ENCODED_BYTES}`;
  }
  return null;
}

export interface MemorySample {
  rssBytes: number;
  sampledAtMs: number;
}

export interface MemoryReservation {
  release(): void;
}

export interface MemoryAdmissionProvider {
  clock(): number;
  sample(): MemorySample | null;
  acquire(bytes: number): MemoryReservation | null;
}

export interface MemoryAdmissionPolicy {
  ceilingBytes: number;
  minReservationBytes: number;
  maxSampleAgeMs: number;
}

export const DEFAULT_MEMORY_POLICY: MemoryAdmissionPolicy = {
  ceilingBytes: 192 * MIB,
  minReservationBytes: 32 * MIB,
  maxSampleAgeMs: 5000,
};

export type MemoryAdmission =
  | { ok: true; reservation: MemoryReservation; reservedBytes: number }
  | { ok: false; message: string };

export function admitMemory(
  provider: MemoryAdmissionProvider,
  policy: MemoryAdmissionPolicy,
  accountedBytes: number,
): MemoryAdmission {
  const sample = provider.sample();
  if (
    sample === null ||
    !Number.isFinite(sample.rssBytes) ||
    sample.rssBytes < 0 ||
    !Number.isFinite(sample.sampledAtMs)
  ) {
    return { ok: false, message: "no memory sample is available" };
  }
  const age = provider.clock() - sample.sampledAtMs;
  if (age < 0 || age > policy.maxSampleAgeMs) {
    return {
      ok: false,
      message: `memory sample is ${age} ms old; limit is ${policy.maxSampleAgeMs} ms`,
    };
  }
  const needed = policy.minReservationBytes + 2 * accountedBytes;
  if (sample.rssBytes + needed >= policy.ceilingBytes) {
    return {
      ok: false,
      message: `RSS ${sample.rssBytes} plus reservation ${needed} would reach the ${policy.ceilingBytes} byte ceiling`,
    };
  }
  const reservation = provider.acquire(needed);
  if (reservation === null) {
    return { ok: false, message: "memory reservation was not granted" };
  }
  return { ok: true, reservation, reservedBytes: needed };
}
