import { readFileSync } from "node:fs";

export interface ProcessMemory {
  rssBytes: number;
  peakRssBytes: number | null;
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

export const readProcessMemory: ProcessMemoryReader = (pid) => {
  if (process.platform !== "linux") return null;
  if (!Number.isInteger(pid) || pid <= 0) return null;
  let text: string;
  try {
    text = readFileSync(`/proc/${pid}/status`, "utf8");
  } catch {
    return null;
  }
  return parseProcStatus(text);
};

export function osRssSupported(): boolean {
  return readProcessMemory(process.pid) !== null;
}
