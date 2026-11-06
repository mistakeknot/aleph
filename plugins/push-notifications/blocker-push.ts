import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const BLOCKER_KIND = "blocker";
export const BLOCKER_TIME_ZONE = "America/Los_Angeles";
export const DEFAULT_BLOCKER_DAILY_CAP = 3;
export const MAX_BLOCKER_DAILY_CAP = 100;
export const BLOCKER_STATUS_DAYS = 14;
export const BLOCKER_SOURCE_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/u;

const DAY_KEY_PREFIX = "blocker-day:";
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

const dayFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: BLOCKER_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export const blockerCountsSchema = z
  .object({
    sent: z.number().int().nonnegative(),
    capped: z.number().int().nonnegative(),
    deduped: z.number().int().nonnegative(),
  })
  .strict();

const blockerDayRowSchema = blockerCountsSchema
  .extend({ keys: z.array(z.string()) })
  .strict();

export type BlockerCounts = z.infer<typeof blockerCountsSchema>;
type BlockerDayRow = z.infer<typeof blockerDayRowSchema>;

export type BlockerOutcome = "sent" | "capped" | "deduped";

export interface BlockerAdmission {
  outcome: BlockerOutcome;
  day: string;
  cap: number;
  sentToday: number;
}

export interface BlockerDayView {
  day: string;
  total: BlockerCounts;
  sources: Record<string, BlockerCounts>;
}

export function pacificDay(at: number): string {
  const parts = dayFormatter.formatToParts(new Date(at));
  const pick = (type: string) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${pick("year")}-${pick("month")}-${pick("day")}`;
}

export function shiftDay(day: string, days: number): string {
  const [year = 0, month = 1, date = 1] = day.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, date + days))
    .toISOString()
    .slice(0, 10);
}

function emptyRow(): BlockerDayRow {
  return { sent: 0, capped: 0, deduped: 0, keys: [] };
}

function rowKey(day: string, source: string): string {
  return `${DAY_KEY_PREFIX}${day}:${source}`;
}

export interface BlockerLedger {
  admit(args: {
    source: string;
    dedupeKey: string | null;
    cap: number;
    at: number;
  }): Promise<BlockerAdmission>;
  recent(at: number): Promise<BlockerDayView[]>;
}

export function createBlockerLedger(bb: BbPluginApi): BlockerLedger {
  let queue: Promise<void> = Promise.resolve();

  function serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = queue.then(operation, operation);
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async function readRow(key: string): Promise<BlockerDayRow> {
    const parsed = blockerDayRowSchema.safeParse(
      await bb.storage.kv.get<unknown>(key),
    );
    return parsed.success ? parsed.data : emptyRow();
  }

  async function prune(today: string): Promise<void> {
    const oldest = shiftDay(today, -(BLOCKER_STATUS_DAYS - 1));
    for (const key of await bb.storage.kv.list(DAY_KEY_PREFIX)) {
      const day = key.slice(DAY_KEY_PREFIX.length, DAY_KEY_PREFIX.length + 10);
      if (DAY_PATTERN.test(day) && day < oldest) {
        await bb.storage.kv.delete(key);
      }
    }
  }

  return {
    admit({ source, dedupeKey, cap, at }) {
      return serialize(async () => {
        const day = pacificDay(at);
        const key = rowKey(day, source);
        const row = await readRow(key);
        let outcome: BlockerOutcome = "sent";
        let sentTotal = row.sent;
        if (dedupeKey !== null && row.keys.includes(dedupeKey)) {
          outcome = "deduped";
        } else {
          sentTotal = 0;
          for (const other of await bb.storage.kv.list(
            `${DAY_KEY_PREFIX}${day}:`,
          )) {
            sentTotal += (await readRow(other)).sent;
          }
          if (sentTotal >= cap) outcome = "capped";
        }
        const next: BlockerDayRow =
          outcome === "sent"
            ? {
                ...row,
                sent: row.sent + 1,
                keys: dedupeKey === null ? row.keys : [...row.keys, dedupeKey],
              }
            : { ...row, [outcome]: row[outcome] + 1 };
        await bb.storage.kv.set(key, next);
        await prune(day);
        return {
          outcome,
          day,
          cap,
          sentToday: outcome === "sent" ? sentTotal + 1 : sentTotal,
        };
      });
    },
    recent(at) {
      return serialize(async () => {
        const today = pacificDay(at);
        const views: BlockerDayView[] = [];
        for (let offset = 0; offset < BLOCKER_STATUS_DAYS; offset += 1) {
          const day = shiftDay(today, -offset);
          const sources: Record<string, BlockerCounts> = {};
          const total: BlockerCounts = { sent: 0, capped: 0, deduped: 0 };
          for (const key of await bb.storage.kv.list(
            `${DAY_KEY_PREFIX}${day}:`,
          )) {
            const source = key.slice(`${DAY_KEY_PREFIX}${day}:`.length);
            const { sent, capped, deduped } = await readRow(key);
            sources[source] = { sent, capped, deduped };
            total.sent += sent;
            total.capped += capped;
            total.deduped += deduped;
          }
          views.push({ day, total, sources });
        }
        return views;
      });
    },
  };
}
