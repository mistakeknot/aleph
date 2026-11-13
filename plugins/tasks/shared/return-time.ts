import { z } from "zod";

export function parseReturnTime(input: string, now = Date.now()): string {
  const relative = /^in\s+(\d+(?:\.\d+)?)\s*(m|h|d)$/i.exec(input.trim());
  const scale: Record<string, number> = {
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
  };
  let at: number;
  if (relative) {
    at = now + Number(relative[1]) * scale[relative[2].toLowerCase()];
  } else {
    const clock = /^(?:at\s+)?(\d{2}):(\d{2})\s+UTC$/i.exec(input.trim());
    if (clock) {
      if (Number(clock[1]) > 23 || Number(clock[2]) > 59)
        throw new Error("Invalid UTC clock time");
      const date = new Date(now);
      date.setUTCHours(Number(clock[1]), Number(clock[2]), 0, 0);
      at = date.valueOf();
      if (at <= now) at += 86_400_000;
    } else {
      if (!z.iso.datetime().safeParse(input).success)
        throw new Error(
          "Use a UTC ISO timestamp, at HH:MM UTC, or in <number>m/h/d",
        );
      at = Date.parse(input);
    }
  }
  if (!Number.isFinite(at) || at - now < 60_000 || at - now > 30 * 86_400_000)
    throw new Error("Return time must be between 1 minute and 30 days ahead");
  return new Date(at).toISOString();
}
