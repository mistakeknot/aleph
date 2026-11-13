import { z } from "zod";
import { wakeCauseSchema, wakeRefSchema } from "@bb/domain";

export const wakeEffectKindSchema = z.enum([
  "file",
  "commit",
  "task",
  "card",
  "outbound_message",
]);
const coverageSchema = z.enum(["complete", "partial", "unknown"]);
export const wakeOutcomesQuerySchema = z.object({
  cursor: z.string().min(1).max(2048).optional(),
});
export type WakeOutcomesQuery = z.infer<typeof wakeOutcomesQuerySchema>;
export const wakeTurnOutcomeSchema = z.object({
  turnId: z.string(),
  completed: z.boolean(),
  wakeCause: wakeCauseSchema,
  wakeRef: wakeRefSchema.nullable(),
  wakeSources: z
    .array(
      z.object({
        wakeCause: wakeCauseSchema,
        wakeRef: wakeRefSchema.nullable(),
      }),
    )
    .max(32),
  wakeSourcesTruncated: z.boolean(),
  requestsTruncated: z.boolean(),
  toolCount: z.number().int().nonnegative().nullable(),
  changedAnything: z.union([z.boolean(), z.literal("unknown")]),
  effectKinds: z.array(wakeEffectKindSchema),
  coverage: z.object({
    tools: coverageSchema,
    effects: coverageSchema,
    attribution: coverageSchema,
  }),
  requests: z
    .array(
      z.object({
        requestId: z.string(),
        wakeCause: wakeCauseSchema,
        wakeRef: wakeRefSchema.nullable(),
        postAcceptToolCount: z.number().int().nonnegative().nullable(),
        partialObservationWindow: z.boolean(),
        firstAcceptingTurnId: z.string(),
        retryOfRequestId: z.string().nullable(),
        retryAttempt: z.number().int().nullable(),
        retainedCause: wakeCauseSchema.nullable(),
      }),
    )
    .max(32),
});
export const wakeOutcomesResponseSchema = z.object({
  nextCursor: z.string().nullable(),
  outcomes: z.array(wakeTurnOutcomeSchema).max(100),
  truncated: z.boolean(),
  summary: z.object({
    completedTurns: z.number().int().nonnegative(),
    unknownCauseRate: z.number().nullable(),
    unknownEffectRate: z.number().nullable(),
  }),
});
export type WakeTurnOutcome = z.infer<typeof wakeTurnOutcomeSchema>;
export type WakeOutcomesResponse = z.infer<typeof wakeOutcomesResponseSchema>;
