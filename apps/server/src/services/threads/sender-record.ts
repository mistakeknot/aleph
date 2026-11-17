import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { chmod, lstat, mkdir, open } from "node:fs/promises";
import { join } from "node:path";
import type { RequestAppSurface } from "@bb/config/app-surface";
import type { PromptInput } from "@bb/domain";
import {
  getGateAuthKind,
  getGateMachineId,
  resolveRequestAccessRoute,
  resolveRequestAppSurface,
  resolveRequestSource,
  type ResolvePluginRpcCaller,
} from "../../request-context.js";
import type { ServerLogger } from "../../types.js";

export const SENDER_LOG_FILE_NAME = "sender-log.jsonl";
export const SENDER_LOG_MAX_PENDING = 1000;
const ASSERTED_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;

export type SenderRecordKind = "plugin" | "cli" | "app" | "api";

export interface SenderRecord {
  kind: SenderRecordKind;
  verified: boolean;
  operatorSession: boolean;
  claimedSenderThreadId: string | null;
  callerThreadHeader: string | null;
  pluginId: string | null;
  surface: RequestAppSurface;
  gateAuth: "machine" | "session" | null;
  accessRoute: "connect" | "direct" | "loopback" | null;
  machineId: string | null;
}

export type SenderLogRoute = "send" | "queue";

export interface SenderLogEntry {
  route: SenderLogRoute;
  requestedThreadId: string;
  threadId: string;
  messageSequence: number | null;
  queuedMessageId: string | null;
  sender: SenderRecord;
  textSha256: string;
  textLength: number;
  inputChunkCount: number;
}

export interface SenderLogSink {
  record(entry: SenderLogEntry): void;
  flush(): Promise<void>;
}

export type SenderRequestContext = Parameters<
  typeof resolveRequestAccessRoute
>[0];

export function boundAssertedId(
  value: string | null | undefined,
): string | null {
  if (value === null || value === undefined) return null;
  if (ASSERTED_ID_PATTERN.test(value)) return value;
  const digest = createHash("sha256").update(value).digest("hex").slice(0, 16);
  return `invalid:${digest}:${value.length}`;
}

export function readSenderRecord(
  context: SenderRequestContext,
  args: {
    claimedSenderThreadId: string | undefined;
    resolvePluginCaller: ResolvePluginRpcCaller;
  },
): SenderRecord {
  const source = resolveRequestSource(context, args.resolvePluginCaller);
  const gateAuth = getGateAuthKind(context);
  const accessRoute = resolveRequestAccessRoute(context);
  const operatorSession = accessRoute === "connect" && gateAuth === "session";
  return {
    kind: source.kind,
    verified: source.kind === "plugin" || operatorSession,
    operatorSession,
    claimedSenderThreadId: boundAssertedId(args.claimedSenderThreadId),
    callerThreadHeader: boundAssertedId(
      source.kind === "cli" ? source.callerThreadId : null,
    ),
    pluginId: source.kind === "plugin" ? source.pluginId : null,
    surface: resolveRequestAppSurface(context),
    gateAuth,
    accessRoute,
    machineId: boundAssertedId(getGateMachineId(context)),
  };
}

export function hashPromptText(input: readonly PromptInput[]): {
  textSha256: string;
  textLength: number;
  inputChunkCount: number;
} {
  const text = input
    .map((chunk) => (chunk.type === "text" ? chunk.text : ""))
    .join("");
  return {
    textSha256: createHash("sha256").update(text).digest("hex"),
    textLength: text.length,
    inputChunkCount: input.length,
  };
}

function safeWarn(logger: ServerLogger, message: string): void {
  try {
    logger.warn(message);
  } catch {
    return;
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function ownedByThisProcess(uid: number): boolean {
  return typeof process.getuid !== "function" || uid === process.getuid();
}

async function appendPrivately(
  dir: string,
  file: string,
  payload: string,
): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const dirStat = await lstat(dir);
  if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
    throw new Error("sender log directory is not a plain directory");
  }
  if (!ownedByThisProcess(dirStat.uid)) {
    throw new Error("sender log directory is owned by another user");
  }
  if ((dirStat.mode & 0o077) !== 0) await chmod(dir, 0o700);
  const handle = await open(
    file,
    fsConstants.O_WRONLY |
      fsConstants.O_APPEND |
      fsConstants.O_CREAT |
      fsConstants.O_NOFOLLOW |
      fsConstants.O_NONBLOCK,
    0o600,
  );
  try {
    const fileStat = await handle.stat();
    if (!fileStat.isFile()) {
      throw new Error("sender log path is not a regular file");
    }
    if (!ownedByThisProcess(fileStat.uid)) {
      throw new Error("sender log file is owned by another user");
    }
    if ((fileStat.mode & 0o077) !== 0) await handle.chmod(0o600);
    await handle.appendFile(payload);
  } finally {
    await handle.close();
  }
}

export function createSenderLogSink(args: {
  dataDir: string;
  logger: ServerLogger;
  now?: () => number;
  maxPending?: number;
}): SenderLogSink {
  const now = args.now ?? Date.now;
  const maxPending = args.maxPending ?? SENDER_LOG_MAX_PENDING;
  const dir = join(args.dataDir, "sender-log");
  const file = join(dir, SENDER_LOG_FILE_NAME);
  let pending: string[] = [];
  let dropped = 0;
  let draining: Promise<void> | null = null;

  async function drain(): Promise<void> {
    while (pending.length > 0) {
      const batch = pending;
      pending = [];
      try {
        await appendPrivately(dir, file, batch.join(""));
      } catch (error) {
        safeWarn(
          args.logger,
          `sender log append failed (${batch.length} lines lost): ${describeError(error)}`,
        );
      }
    }
  }

  function schedule(): Promise<void> {
    if (draining === null) {
      draining = drain().finally(() => {
        draining = null;
        if (pending.length > 0) void schedule();
      });
    }
    return draining;
  }

  return {
    record(entry) {
      if (pending.length >= maxPending) {
        dropped += 1;
        if (dropped === 1 || dropped % maxPending === 0) {
          safeWarn(
            args.logger,
            `sender log backlog full; ${dropped} lines dropped so far`,
          );
        }
        return;
      }
      pending.push(
        `${JSON.stringify({ at: new Date(now()).toISOString(), ...entry })}\n`,
      );
      void schedule();
    },
    async flush() {
      while (draining !== null || pending.length > 0) {
        await schedule();
      }
    },
  };
}

export function logThreadSender(
  sink: SenderLogSink,
  logger: ServerLogger,
  context: SenderRequestContext,
  args: {
    route: SenderLogRoute;
    requestedThreadId: string;
    threadId: string;
    messageSequence: number | null;
    queuedMessageId: string | null;
    claimedSenderThreadId: string | undefined;
    input: readonly PromptInput[];
    resolvePluginCaller: ResolvePluginRpcCaller;
  },
): void {
  try {
    sink.record({
      route: args.route,
      requestedThreadId: args.requestedThreadId,
      threadId: args.threadId,
      messageSequence: args.messageSequence,
      queuedMessageId: args.queuedMessageId,
      sender: readSenderRecord(context, {
        claimedSenderThreadId: args.claimedSenderThreadId,
        resolvePluginCaller: args.resolvePluginCaller,
      }),
      ...hashPromptText(args.input),
    });
  } catch (error) {
    safeWarn(logger, `sender record failed: ${describeError(error)}`);
  }
}
