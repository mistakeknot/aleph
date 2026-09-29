import { appendFile, mkdir, readdir, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  bbDesktopDiagnosticEventSchema,
  type BbDesktopDiagnosticEvent,
} from "@bb/desktop-contract";

export const RENDERER_LOG_RETENTION_DAYS = 5;
export const RENDERER_LOG_MAX_FILE_BYTES = 5 * 1024 * 1024;
export const RENDERER_CONSOLE_MESSAGE_MAX_CHARS = 200;

const RENDERER_LOG_FILE_PATTERN =
  /^aleph-renderer-(\d{4})-(\d{2})-(\d{2})\.log$/;

export function resolveRendererLogDirectory(
  platform: NodeJS.Platform,
  fallbackLogsPath: string,
): string {
  return platform === "darwin"
    ? join(homedir(), "Library", "Logs", "Aleph")
    : join(fallbackLogsPath, "Aleph");
}

function padDatePart(value: number): string {
  return String(value).padStart(2, "0");
}

function formatLocalDay(date: Date): string {
  return `${date.getFullYear()}-${padDatePart(date.getMonth() + 1)}-${padDatePart(date.getDate())}`;
}

export function rendererLogFileName(day: string): string {
  return `aleph-renderer-${day}.log`;
}

const SECRET_KEY_ASSIGNMENT =
  /\b(token|secret|password|passwd|authorization|api[_-]?key|cookie|session)(["']?\s*[:=]\s*)("[^"]*"|'[^']*'|\S+)/gi;
const CONTENT_KEY_ASSIGNMENT =
  /\b(body|text|prompt|message|content|attachments?|input|payload)(["']?\s*[:=]\s*).*$/gi;
const BEARER_TOKEN = /\b(Bearer|Basic)\s+\S+/gi;
const URL_WITH_QUERY = /(\bhttps?:\/\/[^\s?#"']+)[?#]\S*/gi;
const PREFIXED_TOKEN =
  /\b(?:sk|pk|ghp|gho|ghu|ghs|github_pat|xox[a-z]|eyJ)[A-Za-z0-9_-]{6,}[A-Za-z0-9._-]*/g;
const LONG_OPAQUE_STRING = /[A-Za-z0-9+/=_-]{32,}/g;

export function scrubRendererLogText(text: string): string {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  return firstLine
    .replace(URL_WITH_QUERY, "$1")
    .replace(BEARER_TOKEN, "$1 [redacted]")
    .replace(SECRET_KEY_ASSIGNMENT, "$1$2[redacted]")
    .replace(CONTENT_KEY_ASSIGNMENT, "$1$2[redacted]")
    .replace(PREFIXED_TOKEN, "[redacted]")
    .replace(LONG_OPAQUE_STRING, "[redacted]")
    .slice(0, RENDERER_CONSOLE_MESSAGE_MAX_CHARS);
}

export type RendererConsoleLevel = "debug" | "info" | "warning" | "error";

export interface RendererConsoleRecord {
  level: RendererConsoleLevel;
  line: number;
  message: string;
  sourceFile: string;
}

export function buildRendererConsoleRecord(args: {
  level: RendererConsoleLevel;
  line: number;
  message: string;
  sourceId: string;
}): RendererConsoleRecord | null {
  if (args.level !== "warning" && args.level !== "error") {
    return null;
  }
  const withoutQuery = args.sourceId.split(/[?#]/, 1)[0] ?? "";
  const sourceFile = withoutQuery.slice(withoutQuery.lastIndexOf("/") + 1);
  return {
    level: args.level,
    line: args.line,
    message: scrubRendererLogText(args.message),
    sourceFile: scrubRendererLogText(sourceFile),
  };
}

export function parseRendererDiagnosticEvent(
  payload: unknown,
): BbDesktopDiagnosticEvent | null {
  const parsed = bbDesktopDiagnosticEventSchema.safeParse(payload);
  return parsed.success ? parsed.data : null;
}

export interface RendererLogWriterOptions {
  directory: string;
  maxFileBytes?: number;
  now?: () => Date;
  retentionDays?: number;
}

export interface RendererLogWriter {
  flush(): Promise<void>;
  write(record: object): void;
}

export function createRendererLogWriter({
  directory,
  maxFileBytes = RENDERER_LOG_MAX_FILE_BYTES,
  now = () => new Date(),
  retentionDays = RENDERER_LOG_RETENTION_DAYS,
}: RendererLogWriterOptions): RendererLogWriter {
  let queue: Promise<void> = Promise.resolve();
  let currentDay: string | null = null;
  let currentBytes = 0;
  let truncated = false;

  async function pruneOldFiles(today: Date): Promise<void> {
    const oldestKept = new Date(
      today.getFullYear(),
      today.getMonth(),
      today.getDate() - (retentionDays - 1),
    );
    const cutoff = formatLocalDay(oldestKept);
    for (const name of await readdir(directory)) {
      const match = RENDERER_LOG_FILE_PATTERN.exec(name);
      if (match === null) {
        continue;
      }
      if (`${match[1]}-${match[2]}-${match[3]}` < cutoff) {
        await rm(join(directory, name), { force: true });
      }
    }
  }

  async function startDay(day: string, today: Date): Promise<void> {
    await mkdir(directory, { recursive: true });
    currentDay = day;
    truncated = false;
    try {
      currentBytes = (await stat(join(directory, rendererLogFileName(day)))).size;
    } catch {
      currentBytes = 0;
    }
    await pruneOldFiles(today);
  }

  async function append(record: object): Promise<void> {
    const moment = now();
    const day = formatLocalDay(moment);
    if (day !== currentDay) {
      await startDay(day, moment);
    }
    if (truncated) {
      return;
    }
    const file = join(directory, rendererLogFileName(day));
    const line = `${JSON.stringify({ t: moment.toISOString(), ...record })}\n`;
    const bytes = Buffer.byteLength(line);
    if (currentBytes + bytes > maxFileBytes) {
      truncated = true;
      await appendFile(
        file,
        `${JSON.stringify({ t: moment.toISOString(), kind: "log-truncated", maxFileBytes })}\n`,
      );
      return;
    }
    await appendFile(file, line);
    currentBytes += bytes;
  }

  return {
    flush: () => queue,
    write(record) {
      queue = queue.then(
        () => append(record),
        () => append(record),
      );
      queue = queue.catch(() => undefined);
    },
  };
}
