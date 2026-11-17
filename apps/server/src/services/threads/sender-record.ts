import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
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
  threadId: string;
  messageSequence: number | null;
  queuedMessageId: string | null;
  sender: SenderRecord;
  textSha256: string;
  textLength: number;
}

export interface SenderLogSink {
  record(entry: SenderLogEntry): void;
}

export type SenderRequestContext = Parameters<
  typeof resolveRequestAccessRoute
>[0];

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
    claimedSenderThreadId: args.claimedSenderThreadId ?? null,
    callerThreadHeader: source.kind === "cli" ? source.callerThreadId : null,
    pluginId: source.kind === "plugin" ? source.pluginId : null,
    surface: resolveRequestAppSurface(context),
    gateAuth,
    accessRoute,
    machineId: getGateMachineId(context),
  };
}

export function hashPromptText(input: readonly PromptInput[]): {
  textSha256: string;
  textLength: number;
} {
  const text = input
    .map((chunk) => (chunk.type === "text" ? chunk.text : ""))
    .join("");
  return {
    textSha256: createHash("sha256").update(text).digest("hex"),
    textLength: text.length,
  };
}

export function createSenderLogSink(args: {
  dataDir: string;
  logger: ServerLogger;
  now?: () => number;
}): SenderLogSink {
  const now = args.now ?? Date.now;
  const dir = join(args.dataDir, "sender-log");
  const file = join(dir, SENDER_LOG_FILE_NAME);
  return {
    record(entry) {
      try {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        appendFileSync(
          file,
          `${JSON.stringify({ at: new Date(now()).toISOString(), ...entry })}\n`,
          { mode: 0o600 },
        );
      } catch (error) {
        args.logger.warn(
          `sender log append failed: ${error instanceof Error ? error.message : String(error)}`,
        );
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
    logger.warn(
      `sender record failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
