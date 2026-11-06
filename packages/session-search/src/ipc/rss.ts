import { readFileSync } from "node:fs";

export interface ProcessMemory {
  rssBytes: number;
  peakRssBytes: number | null;
  incarnation?: string | null;
}

export type ProcessMemoryReader = (pid: number) => ProcessMemory | null;

const RSS_LINE = /^VmRSS:\s+(\d+)\s+kB\s*$/m;
const HWM_LINE = /^VmHWM:\s+(\d+)\s+kB\s*$/m;

export function parseProcStatus(text: string): ProcessMemory | null {
  const rss = RSS_LINE.exec(text);
  if (rss === null) return null;
  const peak = HWM_LINE.exec(text);
  return {
    rssBytes: Number(rss[1]) * 1024,
    peakRssBytes: peak === null ? null : Number(peak[1]) * 1024,
  };
}

export function parseProcStartTime(text: string): string | null {
  const close = text.lastIndexOf(")");
  if (close < 0) return null;
  const fields = text
    .slice(close + 1)
    .trim()
    .split(/\s+/);
  const start = fields[19];
  if (start === undefined || !/^\d+$/.test(start)) return null;
  return start;
}

function readStartTime(pid: number): string | null {
  try {
    return parseProcStartTime(readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return null;
  }
}

export const readProcessMemory: ProcessMemoryReader = (pid) => {
  if (process.platform !== "linux") return null;
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const before = readStartTime(pid);
  if (before === null) return null;
  let text: string;
  try {
    text = readFileSync(`/proc/${pid}/status`, "utf8");
  } catch {
    return null;
  }
  const parsed = parseProcStatus(text);
  if (parsed === null) return null;
  if (readStartTime(pid) !== before) return null;
  return { ...parsed, incarnation: before };
};

export function osRssSupported(): boolean {
  return readProcessMemory(process.pid) !== null;
}
