import { z } from "zod";

export const DIAGNOSTIC_ID_PATTERN = /^[a-z]{2,8}_[A-Za-z0-9]{1,40}$/;
export const DIAGNOSTIC_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9-]{0,31}$/;
export const DIAGNOSTIC_REASON_PATTERN = /^[a-z][a-z_-]{0,31}$/;
export const DIAGNOSTIC_CONSOLE_CODE_PATTERN = /^[A-Z_]{3,40}$/;
export const DIAGNOSTIC_CONSOLE_FALLBACK_CODE = "console_error";

const diagnosticIdSchema = z.string().regex(DIAGNOSTIC_ID_PATTERN);
const diagnosticNameSchema = z.string().regex(DIAGNOSTIC_NAME_PATTERN);
const diagnosticReasonSchema = z.string().regex(DIAGNOSTIC_REASON_PATTERN);
const diagnosticTimestampSchema = z.number().int().nonnegative();
const diagnosticCountSchema = z.number().int().nonnegative();

export const bbDesktopDiagnosticComposerSendStateSchema = z.enum([
  "ready",
  "queue",
  "queue-while-stopping",
  "blocked-loading-pending-interactions",
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
  queryName: diagnosticNameSchema,
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
    reason: diagnosticReasonSchema.nullable(),
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
    invalidatedCount: diagnosticCountSchema,
    skippedCount: diagnosticCountSchema,
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
    runtimeStatus: diagnosticReasonSchema.nullable(),
    state: bbDesktopDiagnosticComposerSendStateSchema,
    threadId: diagnosticIdSchema,
  }),
]);
export type BbDesktopDiagnosticEvent = z.infer<
  typeof bbDesktopDiagnosticEventSchema
>;
