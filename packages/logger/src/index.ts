import type { EventEmitter } from "node:events";
import { fstatSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import pino from "pino";
import type { Logger } from "pino";
import { loadLoggerConfig } from "@bb/config/logger";

export type { Logger };

const ROTATED_LOG_FILE_COUNT = 5;

export { isLogTransportFailure } from "./transport-failure.js";

export interface GuardableLogTransport extends EventEmitter {
  write(chunk: string): boolean;
  flushSync(): void;
  end(): void;
}

interface GuardLogTransportOptions {
  notify?: (text: string) => void;
}

function writeStderrNotice(text: string): void {
  try {
    process.stderr.write(text, () => {});
  } catch {}
}

function describeFailure(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === "string"
      ? `${code}: ${error.message}`
      : error.message;
  }
  return String(error);
}

function clearThreadStreamBuffer(stream: object): void {
  // thread-stream keeps its pending text in a private state object. After the
  // worker dies the shared write index is -2, and a flush that is already
  // scheduled would write at that offset inside a setImmediate callback.
  // Emptying the pending text turns that flush into a no-op.
  try {
    for (const key of Object.getOwnPropertySymbols(stream)) {
      if (key.description !== "kImpl") continue;
      const impl = (stream as Record<symbol, unknown>)[key];
      if (impl !== null && typeof impl === "object" && "buf" in impl) {
        (impl as { buf: string }).buf = "";
      }
    }
  } catch {}
}

/**
 * Makes a log transport failure non-fatal. On the first error the stream stops
 * writing, a single short notice goes to stderr, and later writes, flushes and
 * the exit-time end become no-ops so they cannot throw or change the exit code.
 */
export function guardLogTransport(
  stream: GuardableLogTransport,
  options: GuardLogTransportOptions = {},
): void {
  const notify = options.notify ?? writeStderrNotice;
  let degraded = false;
  const degrade = (error: unknown): void => {
    if (degraded) return;
    degraded = true;
    clearThreadStreamBuffer(stream);
    try {
      notify(
        `[bb] log transport failed (${describeFailure(error)}); logging to files is disabled for this process\n`,
      );
    } catch {}
  };
  // Wrap the synchronous operations up front. thread-stream reports a dead
  // worker as an async 'error' event, but write() and the exit-time
  // flushSync() can throw before that event is delivered.
  const originalWrite = stream.write.bind(stream);
  const originalFlushSync = stream.flushSync.bind(stream);
  const originalEnd = stream.end.bind(stream);
  stream.write = (chunk) => {
    if (degraded) return true;
    try {
      return originalWrite(chunk);
    } catch (error) {
      degrade(error);
      return true;
    }
  };
  stream.flushSync = () => {
    if (degraded) return;
    try {
      originalFlushSync();
    } catch (error) {
      degrade(error);
    }
  };
  stream.end = () => {
    if (degraded) return;
    try {
      originalEnd();
    } catch (error) {
      degrade(error);
    }
  };
  stream.on("error", degrade);
}

interface CreateLoggerOptions {
  component: string;
  base?: Record<string, unknown>;
  dataDir?: string;
}

function sanitizeComponentName(component: string): string {
  const trimmed = component.trim();
  if (!trimmed) {
    throw new Error("Logger component is required");
  }

  return trimmed.replace(/[^a-zA-Z0-9._-]+/gu, "-");
}

function stdoutIsPlainFile(): boolean {
  try {
    return fstatSync(1).isFile();
  } catch {
    return false;
  }
}

function pruneRotatedLogFiles(logDir: string, component: string): void {
  const prefix = `${component}.`;
  const rotatedFiles = readdirSync(logDir)
    .filter(
      (entry) =>
        entry.startsWith(prefix) &&
        /^\d+\.log$/u.test(entry.slice(prefix.length)),
    )
    .map((entry) => {
      const path = join(logDir, entry);
      return { mtimeMs: statSync(path).mtimeMs, path };
    })
    .sort((left, right) => right.mtimeMs - left.mtimeMs);
  for (const { path } of rotatedFiles.slice(ROTATED_LOG_FILE_COUNT)) {
    rmSync(path, { force: true });
  }
}

export function createLogger(options: CreateLoggerOptions): Logger {
  const component = sanitizeComponentName(options.component);
  const loggerConfig = loadLoggerConfig({ dataDir: options.dataDir });
  const dataDir = loggerConfig.BB_DATA_DIR;
  const logDir = join(dataDir, "logs");
  mkdirSync(logDir, { recursive: true });
  pruneRotatedLogFiles(logDir, component);
  const loggerOptions = {
    level: loggerConfig.BB_LOG_LEVEL,
    base: {
      component,
      ...(options.base ?? {}),
    },
    serializers: {
      err: pino.stdSerializers.errWithCause,
      error: pino.stdSerializers.errWithCause,
    },
  } satisfies pino.LoggerOptions;

  const targets: pino.TransportTargetOptions[] = [
    {
      target: "pino-roll",
      options: {
        file: join(logDir, `${component}.log`),
        frequency: "daily",
        limit: { count: ROTATED_LOG_FILE_COUNT },
        size: "10m",
      },
      level: loggerConfig.BB_LOG_LEVEL,
    },
  ];

  if (!process.env.VITEST && !stdoutIsPlainFile()) {
    targets.push({
      target: "pino-pretty",
      options: {
        ignore: "pid,hostname,component",
        messageFormat: "[{component}] {msg}",
        singleLine: true,
        translateTime: "SYS:HH:MM:ss",
      },
      level: loggerConfig.BB_LOG_LEVEL,
    });
  }

  const transport = pino.transport({ targets });
  guardLogTransport(transport);

  return pino(loggerOptions, transport);
}
