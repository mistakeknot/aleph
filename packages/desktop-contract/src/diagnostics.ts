import { z } from "zod";

const diagnosticTokenSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[A-Za-z0-9_.:-]+$/);
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
  queryName: diagnosticTokenSchema,
  subjectId: diagnosticTokenSchema.nullable(),
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
    reason: diagnosticTokenSchema.nullable(),
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
    threadId: diagnosticTokenSchema,
  }),
  z.object({
    at: diagnosticTimestampSchema,
    kind: z.literal("composer-send-state"),
    previous: bbDesktopDiagnosticComposerSendStateSchema.nullable(),
    runtimeStatus: diagnosticTokenSchema.nullable(),
    state: bbDesktopDiagnosticComposerSendStateSchema,
    threadId: diagnosticTokenSchema,
  }),
]);
export type BbDesktopDiagnosticEvent = z.infer<
  typeof bbDesktopDiagnosticEventSchema
>;
