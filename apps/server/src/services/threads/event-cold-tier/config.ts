import { z } from "zod";

export const COLD_SEGMENT_READ_LIMIT = 256 * 1024 * 1024;
export const COLD_SEGMENT_HEADER_ALLOWANCE_BYTES = 16 * 1024 * 1024;
export const COLD_MOVE_MAX_THREAD_BYTES_CEILING =
  COLD_SEGMENT_READ_LIMIT - COLD_SEGMENT_HEADER_ALLOWANCE_BYTES;

const DAY_MS = 24 * 60 * 60 * 1000;

export type EventColdTierMode = "off" | "dry-run" | "on";

export interface EventColdTierConfig {
  maxThreadBytes: number;
  maxThreadBytesClamped: boolean;
  minArchivedMs: number;
  mode: EventColdTierMode;
  rehotCooldownMs: number;
}

export const EVENT_COLD_TIER_DEFAULTS = {
  maxThreadBytes: 32 * 1024 * 1024,
  minArchivedDays: 14,
  rehotDays: 7,
} as const;

const positiveNumberSchema = z.coerce.number().finite().positive();

function readPositiveNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const parsed = positiveNumberSchema.safeParse(raw);
  return parsed.success ? parsed.data : fallback;
}

export function resolveEventColdTierMode(): EventColdTierMode {
  const raw = process.env.BB_EVENT_COLD_TIER?.trim();
  if (raw === "1") {
    return "on";
  }
  if (raw === "dry-run") {
    return "dry-run";
  }
  return "off";
}

export function resolveEventColdTierConfig(): EventColdTierConfig {
  const requestedMaxThreadBytes = Math.floor(
    readPositiveNumber(
      "BB_EVENT_COLD_MAX_THREAD_BYTES",
      EVENT_COLD_TIER_DEFAULTS.maxThreadBytes,
    ),
  );
  const maxThreadBytes = Math.min(
    requestedMaxThreadBytes,
    COLD_MOVE_MAX_THREAD_BYTES_CEILING,
  );
  return {
    maxThreadBytes,
    maxThreadBytesClamped: maxThreadBytes !== requestedMaxThreadBytes,
    minArchivedMs:
      readPositiveNumber(
        "BB_EVENT_COLD_MIN_ARCHIVED_DAYS",
        EVENT_COLD_TIER_DEFAULTS.minArchivedDays,
      ) * DAY_MS,
    mode: resolveEventColdTierMode(),
    rehotCooldownMs:
      readPositiveNumber(
        "BB_EVENT_COLD_REHOT_DAYS",
        EVENT_COLD_TIER_DEFAULTS.rehotDays,
      ) * DAY_MS,
  };
}
