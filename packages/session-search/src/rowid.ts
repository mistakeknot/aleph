export const COUNTER_BITS = 20n;
export const COUNTER_LIMIT = 1n << COUNTER_BITS;
export const MS_LIMIT = 1n << 43n;
export const ROWID_MIN = 0n;
export const ROWID_MAX = (MS_LIMIT << COUNTER_BITS) - 1n;

export function isValidEventMs(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    BigInt(value) < MS_LIMIT
  );
}

export function composeRowid(eventMs: bigint, counter: bigint): bigint {
  if (eventMs < 0n || eventMs >= MS_LIMIT) {
    throw new RangeError("event_ms outside [0, 2^43)");
  }
  if (counter < 0n || counter >= COUNTER_LIMIT) {
    throw new RangeError("counter outside [0, 2^20)");
  }
  return eventMs * COUNTER_LIMIT + counter;
}

export function splitRowid(rowid: bigint): {
  eventMs: bigint;
  counter: bigint;
} {
  if (rowid < ROWID_MIN || rowid > ROWID_MAX) {
    throw new RangeError("rowid outside the time-keyed range");
  }
  return { eventMs: rowid / COUNTER_LIMIT, counter: rowid % COUNTER_LIMIT };
}

export interface RowidBounds {
  min: bigint;
  max: bigint;
  empty: boolean;
}

function clampMs(ms: bigint): bigint {
  if (ms < 0n) return 0n;
  if (ms > MS_LIMIT) return MS_LIMIT;
  return ms;
}

function toMsBigInt(value: number | bigint, label: string): bigint {
  if (typeof value === "bigint") return value;
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`${label} must be a safe integer`);
  }
  return BigInt(value);
}

export function rowidBoundsForRange(
  sinceMs?: number | bigint | null,
  untilMs?: number | bigint | null,
): RowidBounds {
  const min =
    sinceMs === undefined || sinceMs === null
      ? ROWID_MIN
      : clampMs(toMsBigInt(sinceMs, "since")) * COUNTER_LIMIT;
  const max =
    untilMs === undefined || untilMs === null
      ? ROWID_MAX
      : clampMs(toMsBigInt(untilMs, "until")) * COUNTER_LIMIT - 1n;
  const clampedMin = min > ROWID_MAX ? ROWID_MAX + 1n : min;
  const clampedMax =
    max < ROWID_MIN ? ROWID_MIN - 1n : max > ROWID_MAX ? ROWID_MAX : max;
  return {
    min: clampedMin,
    max: clampedMax,
    empty: clampedMin > clampedMax,
  };
}

export function serializeRowid(rowid: bigint): string {
  return rowid.toString(10);
}

export function parseRowid(text: string): bigint {
  if (!/^(0|[1-9][0-9]{0,18})$/.test(text)) {
    throw new RangeError("rowid must be a canonical decimal string");
  }
  const value = BigInt(text);
  if (value > ROWID_MAX)
    throw new RangeError("rowid outside the time-keyed range");
  return value;
}
