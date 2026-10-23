import { z } from "zod";

export const eventArchiveFileClassSchema = z.enum([
  "referenced",
  "ended",
  "committed_no_row",
  "uncertain",
  "aborted",
  "unknown",
]);
export type EventArchiveFileClass = z.infer<typeof eventArchiveFileClassSchema>;

export const eventArchiveClassTotalsSchema = z.object({
  bytes: z.number().int().nonnegative(),
  count: z.number().int().nonnegative(),
});

export const eventArchiveClassificationSchema = z.object({
  classes: z.record(eventArchiveFileClassSchema, eventArchiveClassTotalsSchema),
  inconsistencies: z.array(
    z.object({ reason: z.string(), segmentId: z.string() }),
  ),
  missingLiveSegments: z.array(z.string()),
});

export const eventArchiveConfigSchema = z.object({
  maxThreadBytes: z.number().int().positive(),
  maxThreadBytesClamped: z.boolean(),
  minArchivedMs: z.number().positive(),
  mode: z.enum(["off", "dry-run", "on"]),
  rehotCooldownMs: z.number().positive(),
});

export const eventArchiveStatusSchema = eventArchiveClassificationSchema.extend(
  {
    coldThreads: z.number().int().nonnegative(),
    config: eventArchiveConfigSchema,
    queueDepth: z.number().int().nonnegative(),
    segments: z.record(z.string(), z.number().int().nonnegative()),
    zstdAvailable: z.boolean(),
  },
);
export type EventArchiveStatus = z.infer<typeof eventArchiveStatusSchema>;

export const eventArchiveRehydrateRequestSchema = z.union([
  z.object({ threadId: z.string().min(1) }).strict(),
  z.object({ all: z.literal(true) }).strict(),
]);
export type EventArchiveRehydrateRequest = z.infer<
  typeof eventArchiveRehydrateRequestSchema
>;

export const eventArchiveThreadRehydrateResultSchema = z.object({
  outcome: z.enum(["rehydrated", "already_hot"]),
  rowCount: z.number().int().nonnegative(),
  segmentId: z.string().nullable(),
  threadId: z.string(),
  timings: z.record(z.string(), z.number()),
});

export const eventArchiveRehydrateResponseSchema = z.discriminatedUnion(
  "scope",
  [
    z.object({
      scope: z.literal("thread"),
      result: eventArchiveThreadRehydrateResultSchema,
    }),
    z.object({
      scope: z.literal("all"),
      failed: z.array(z.object({ error: z.string(), threadId: z.string() })),
      rehydrated: z.number().int().nonnegative(),
    }),
  ],
);
export type EventArchiveRehydrateResponse = z.infer<
  typeof eventArchiveRehydrateResponseSchema
>;

export const eventArchiveReconcileResponseSchema =
  eventArchiveClassificationSchema.extend({
    orphaned: z.array(z.string()),
    repairedCommitted: z.array(z.string()),
  });
export type EventArchiveReconcileResponse = z.infer<
  typeof eventArchiveReconcileResponseSchema
>;
