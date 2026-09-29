import { threadStatusValues } from "@bb/domain";
import { z } from "zod";

export const DIAGNOSTIC_ID_PATTERN = /^[a-z]{2,8}_[A-Za-z0-9]{1,40}$/;
export const DIAGNOSTIC_OTHER = "other";

export const DIAGNOSTIC_QUERY_NAMES = [
  "hosts",
  "host",
  "projects",
  "sidebarNavigation",
  "projectPaths",
  "threads",
  "threadSearch",
  "thread",
  "threadDetailBootstrap",
  "threadTimeline",
  "threadConversationOutline",
  "threadTimelineTurnSummaryDetails",
  "threadQueuedMessages",
  "threadPromptHistory",
  "threadPendingInteractions",
  "threadDefaultExecutionOptions",
  "threadStorageFiles",
  "threadStorageLocation",
  "threadStoragePaths",
  "threadStorageFilePreview",
  "threadHostFilePreview",
  "terminals",
  "environment",
  "environmentWorkStatus",
  "environmentMergeBaseBranches",
  "environmentDiffFiles",
  "environmentFilePreview",
  "hostPathExistence",
  "systemProviders",
  "systemExecutionOptions",
  "serverMoveStatus",
  "systemVersion",
  "systemAppUpdate",
  "environmentDiffPatch",
] as const;
export const DIAGNOSTIC_CLOSE_REASONS = [
  "normal",
  "going_away",
  "tunnel_disconnected",
  "tunnel_closed",
  "revoked",
  "plugin_reloaded",
  "heartbeat_timeout",
  "invalid_message",
  "inactive_session",
  "unauthorized_session",
  "send_failed",
  "client_closing",
  DIAGNOSTIC_OTHER,
] as const;
export const DIAGNOSTIC_RUNTIME_STATUSES = [
  ...threadStatusValues,
  "provisioning",
  "host-reconnecting",
  "waiting-for-host",
  DIAGNOSTIC_OTHER,
] as const;
export const DIAGNOSTIC_CONSOLE_CODES = [
  "AggregateError",
  "DOMException",
  "Error",
  "EvalError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "TypeError",
  "URIError",
  "console_error",
] as const;
export const DIAGNOSTIC_CONSOLE_FALLBACK_CODE = "console_error";
export const DIAGNOSTIC_CONSOLE_PREFIXES = [
  "react-key-warning",
  "react-update-during-render",
  "react-max-update-depth",
  "react-dom-nesting",
  "react-unmounted-update",
  "react-warning-other",
  "uncaught",
  "unhandled-rejection",
  "vite",
] as const;
export const DIAGNOSTIC_CONSOLE_SOURCE_PATTERN = /^[A-Za-z0-9_.-]{1,80}\.m?js$/;
export const DIAGNOSTIC_CONSOLE_FINGERPRINT_PATTERN = /^[0-9a-f]{8}$/;

const CLOSE_REASON_BY_SERVER_TEXT: ReadonlyMap<string, DiagnosticCloseReason> =
  new Map([
    ["normal", "normal"],
    ["going_away", "going_away"],
    ["tunnel disconnected", "tunnel_disconnected"],
    ["tunnel closed", "tunnel_closed"],
    ["revoked by owner", "revoked"],
    ["Plugin reloaded or disabled", "plugin_reloaded"],
    ["heartbeat-timeout", "heartbeat_timeout"],
    ["invalid-message", "invalid_message"],
    ["inactive-session", "inactive_session"],
    ["unauthorized-session", "unauthorized_session"],
    ["send-failed", "send_failed"],
    ["client closing", "client_closing"],
  ]);

export type DiagnosticConsolePrefix =
  (typeof DIAGNOSTIC_CONSOLE_PREFIXES)[number];
export type DiagnosticCloseReason = (typeof DIAGNOSTIC_CLOSE_REASONS)[number];
export type DiagnosticQueryName = (typeof DIAGNOSTIC_QUERY_NAMES)[number];
export type DiagnosticRuntimeStatus =
  (typeof DIAGNOSTIC_RUNTIME_STATUSES)[number];

function pickFrom<T extends string>(
  table: readonly T[],
  value: unknown,
  fallback: T,
): T {
  return table.find((entry) => entry === value) ?? fallback;
}

export function toDiagnosticCloseReason(
  value: unknown,
): DiagnosticCloseReason | null {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  return CLOSE_REASON_BY_SERVER_TEXT.get(value) ?? DIAGNOSTIC_OTHER;
}

export function toDiagnosticQueryName(
  value: unknown,
): DiagnosticQueryName | typeof DIAGNOSTIC_OTHER {
  return (
    DIAGNOSTIC_QUERY_NAMES.find((name) => name === value) ?? DIAGNOSTIC_OTHER
  );
}

export function toDiagnosticRuntimeStatus(
  value: unknown,
): DiagnosticRuntimeStatus | null {
  return value === null || value === undefined
    ? null
    : pickFrom(DIAGNOSTIC_RUNTIME_STATUSES, value, DIAGNOSTIC_OTHER);
}

const diagnosticIdSchema = z.string().regex(DIAGNOSTIC_ID_PATTERN);
const diagnosticQueryNameSchema = z.enum([
  ...DIAGNOSTIC_QUERY_NAMES,
  DIAGNOSTIC_OTHER,
]);
const diagnosticCloseReasonSchema = z.enum(DIAGNOSTIC_CLOSE_REASONS);
const diagnosticRuntimeStatusSchema = z.enum(DIAGNOSTIC_RUNTIME_STATUSES);
export const bbDesktopDiagnosticConsoleCodeSchema = z.enum(
  DIAGNOSTIC_CONSOLE_CODES,
);
// Written by the main process from Electron console events; never accepted
// from the renderer, so it is not part of bbDesktopDiagnosticEventSchema.
export const bbDesktopDiagnosticConsoleEntrySchema = z.object({
  kind: z.literal("console"),
  code: bbDesktopDiagnosticConsoleCodeSchema,
  count: z.number().int().positive().optional(),
  fingerprint: z
    .string()
    .regex(DIAGNOSTIC_CONSOLE_FINGERPRINT_PATTERN)
    .optional(),
  level: z.enum(["warning", "error"]),
  line: z.number().int().nonnegative().nullable(),
  prefix: z.enum(DIAGNOSTIC_CONSOLE_PREFIXES).nullable().optional(),
  source: z.string().regex(DIAGNOSTIC_CONSOLE_SOURCE_PATTERN).nullable(),
});
export type BbDesktopDiagnosticConsoleEntry = z.infer<
  typeof bbDesktopDiagnosticConsoleEntrySchema
>;
const diagnosticTimestampSchema = z.number().int().nonnegative();
const diagnosticCountSchema = z.number().int().nonnegative();

export const bbDesktopDiagnosticComposerSendStateSchema = z.enum([
  "ready",
  "queue",
  "queue-while-stopping",
  "blocked-loading-pending-interactions",
  "blocked-pending-interactions-check-failed",
  "blocked-pending-interaction",
  "blocked-loading-execution-options",
  "blocked-unavailable",
  "submitting",
]);
export type BbDesktopDiagnosticComposerSendState = z.infer<
  typeof bbDesktopDiagnosticComposerSendStateSchema
>;

const reconnectDecisionSchema = z.object({
  dataUpdatedAt: diagnosticTimestampSchema,
  fetching: z.boolean(),
  invalidated: z.boolean(),
  queryName: diagnosticQueryNameSchema,
  subjectId: diagnosticIdSchema.nullable(),
});

export const bbDesktopDiagnosticEventSchema = z.discriminatedUnion("kind", [
  z.object({
    at: diagnosticTimestampSchema,
    kind: z.literal("socket-open"),
    disconnectedAt: diagnosticTimestampSchema.nullable(),
    reconnected: z.boolean(),
    subscriptionCount: diagnosticCountSchema,
  }),
  z.object({
    at: diagnosticTimestampSchema,
    kind: z.literal("socket-close"),
    code: z.number().int().nullable(),
    pongPending: z.boolean(),
    reason: diagnosticCloseReasonSchema.nullable(),
    wasClean: z.boolean().nullable(),
  }),
  z.object({
    at: diagnosticTimestampSchema,
    kind: z.literal("socket-replaced"),
    pongPending: z.boolean(),
    readyState: z.number().int(),
  }),
  z.object({
    at: diagnosticTimestampSchema,
    kind: z.literal("reconnect-invalidation"),
    decisions: z.array(reconnectDecisionSchema).max(200),
    disconnectedAt: diagnosticTimestampSchema,
    reconnectedAt: diagnosticTimestampSchema,
    invalidatedCount: diagnosticCountSchema,
    skippedCount: diagnosticCountSchema,
  }),
  z.object({
    at: diagnosticTimestampSchema,
    kind: z.literal("reconnect-trailing-refetch"),
    phase: z.enum(["armed", "fired", "dropped"]),
    queryName: diagnosticQueryNameSchema,
    subjectId: diagnosticIdSchema.nullable(),
  }),
  z.object({
    at: diagnosticTimestampSchema,
    kind: z.literal("pending-interactions-guard"),
    outcome: z.enum([
      "blocked-unverified",
      "check-failed",
      "manual-retry",
      "request-timeout",
      "resolved",
    ]),
    threadId: diagnosticIdSchema.nullable(),
  }),
  z.object({
    at: diagnosticTimestampSchema,
    kind: z.literal("thread-sequence-anomaly"),
    anomaly: z.enum(["out-of-order", "long-gap"]),
    deltaMs: z.number().int(),
    previousUpdatedAt: diagnosticTimestampSchema,
    statusUpdatedAt: diagnosticTimestampSchema,
    threadId: diagnosticIdSchema,
  }),
  z.object({
    at: diagnosticTimestampSchema,
    kind: z.literal("composer-send-state"),
    previous: bbDesktopDiagnosticComposerSendStateSchema.nullable(),
    runtimeStatus: diagnosticRuntimeStatusSchema.nullable(),
    state: bbDesktopDiagnosticComposerSendStateSchema,
    threadId: diagnosticIdSchema,
  }),
]);
export type BbDesktopDiagnosticEvent = z.infer<
  typeof bbDesktopDiagnosticEventSchema
>;
