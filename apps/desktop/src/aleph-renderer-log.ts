import { createHash } from "node:crypto";
import { appendFile, mkdir, open, readdir, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  DIAGNOSTIC_CONSOLE_CODES,
  DIAGNOSTIC_CONSOLE_FALLBACK_CODE,
  DIAGNOSTIC_CONSOLE_SOURCE_PATTERN,
  bbDesktopDiagnosticEventSchema,
  type BbDesktopDiagnosticEvent,
  type DiagnosticConsolePrefix,
} from "@bb/desktop-contract";

export const RENDERER_LOG_RETENTION_DAYS = 5;
export const RENDERER_LOG_MAX_FILE_BYTES = 5 * 1024 * 1024;

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

export type RendererConsoleLevel = "debug" | "info" | "warning" | "error";

export interface RendererConsoleRecord {
  code: string;
  fingerprint?: string;
  level: "warning" | "error";
  line: number | null;
  prefix?: DiagnosticConsolePrefix | null;
  source: string | null;
}

const FINGERPRINT_MAX_CHARS = 200;
const CONSOLE_PREFIXES: ReadonlyArray<
  readonly [string, DiagnosticConsolePrefix]
> = [
  ["Warning: Each child in a list should have a unique", "react-key-warning"],
  ["Warning: Cannot update a component", "react-update-during-render"],
  ["Maximum update depth exceeded", "react-max-update-depth"],
  ["Warning: Maximum update depth exceeded", "react-max-update-depth"],
  ["Warning: validateDOMNesting", "react-dom-nesting"],
  ["Warning: Can't perform a React state update", "react-unmounted-update"],
  ["Warning:", "react-warning-other"],
  ["Uncaught", "uncaught"],
  ["Unhandled promise rejection", "unhandled-rejection"],
  ["[vite]", "vite"],
];

export function classifyRendererConsolePrefix(
  message: string,
): DiagnosticConsolePrefix | null {
  const start = message.trimStart();
  return CONSOLE_PREFIXES.find(([lead]) => start.startsWith(lead))?.[1] ?? null;
}

export function maskRendererConsoleMessage(message: string): string {
  return (
    message
      .trimStart()
      .split(/\r?\n/, 1)[0]
      ?.replace(/(["'`])(?:(?!\1).)*\1/g, "?")
      .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S*/gi, "?")
      .replace(
        /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
        "?",
      )
      .replace(/(?:[A-Za-z]:\\|~?\/)\S*/g, "?")
      .replace(/[\w.-]+(?:\/[\w.-]+)+/g, "?")
      .replace(/\b(?:0x)?[0-9a-f]{8,}\b/gi, "?")
      .replace(/[A-Za-z0-9_-]{20,}/g, "?")
      .replace(/\d+/g, "?")
      .slice(0, FINGERPRINT_MAX_CHARS) ?? ""
  );
}

export function fingerprintRendererConsoleMessage(message: string): string {
  return createHash("sha256")
    .update(maskRendererConsoleMessage(message))
    .digest("hex")
    .slice(0, 8);
}

export function sanitizeRendererConsoleSource(
  sourceId: unknown,
): string | null {
  if (typeof sourceId !== "string") {
    return null;
  }
  const withoutQuery = sourceId.split(/[?#]/, 1)[0] ?? "";
  const name = withoutQuery.split(/[\\/]/).pop() ?? "";
  return DIAGNOSTIC_CONSOLE_SOURCE_PATTERN.test(name) ? name : null;
}

export function classifyRendererConsoleMessage(message: string): string {
  const tokens = message.trimStart().split(/\s+/);
  const first = (tokens[0] === "Uncaught" ? tokens[1] : tokens[0]) ?? "";
  const candidate = first.endsWith(":") ? first.slice(0, -1) : first;
  return (
    DIAGNOSTIC_CONSOLE_CODES.find((code) => code === candidate) ??
    DIAGNOSTIC_CONSOLE_FALLBACK_CODE
  );
}

export function buildRendererConsoleRecord(args: {
  level: RendererConsoleLevel;
  message: string;
  sourceId?: unknown;
  lineNumber?: unknown;
}): RendererConsoleRecord | null {
  if (args.level !== "warning" && args.level !== "error") {
    return null;
  }
  const code = classifyRendererConsoleMessage(args.message);
  const attribution = {
    line:
      typeof args.lineNumber === "number" &&
      Number.isInteger(args.lineNumber) &&
      args.lineNumber >= 0
        ? args.lineNumber
        : null,
    source: sanitizeRendererConsoleSource(args.sourceId),
  };
  if (code !== DIAGNOSTIC_CONSOLE_FALLBACK_CODE) {
    return { code, level: args.level, ...attribution };
  }
  return {
    code,
    fingerprint: fingerprintRendererConsoleMessage(args.message),
    level: args.level,
    ...attribution,
    prefix: classifyRendererConsolePrefix(args.message),
  };
}

export function parseRendererDiagnosticEvent(
  payload: unknown,
): BbDesktopDiagnosticEvent | null {
  const parsed = bbDesktopDiagnosticEventSchema.safeParse(payload);
  return parsed.success ? parsed.data : null;
}

const TRUNCATION_MARKER_KIND = "log-truncated";
const TRUNCATION_MARKER_TAIL_BYTES = 512;

async function endsWithTruncationMarker(
  file: string,
  size: number,
): Promise<boolean> {
  const handle = await open(file, "r");
  try {
    const length = Math.min(size, TRUNCATION_MARKER_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    return buffer
      .toString("utf8")
      .includes(`"kind":"${TRUNCATION_MARKER_KIND}"`);
  } finally {
    await handle.close();
  }
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
    const file = join(directory, rendererLogFileName(day));
    try {
      currentBytes = (await stat(file)).size;
      truncated = await endsWithTruncationMarker(file, currentBytes);
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
    const marker = `${JSON.stringify({ t: moment.toISOString(), kind: TRUNCATION_MARKER_KIND, maxFileBytes })}\n`;
    const markerBytes = Buffer.byteLength(marker);
    if (currentBytes + bytes > maxFileBytes - markerBytes) {
      truncated = true;
      if (currentBytes + markerBytes <= maxFileBytes) {
        await appendFile(file, marker);
        currentBytes += markerBytes;
      }
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
