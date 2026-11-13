import { z } from "zod";

export const wakeCauseSchema = z.enum([
  "card_pick",
  "merge",
  "review",
  "timer",
  "message",
  "workflow",
  "retry",
  "restart",
  "interaction",
  "unknown",
]);
export type WakeCause = z.infer<typeof wakeCauseSchema>;
export const wakeRefSchema = z
  .string()
  .describe(
    "Primary reference: the earliest accepted source, retained for mixed and truncated provenance",
  )
  .max(200)
  .refine((value) => value.length <= 200, "Must be at most 200 UTF-16 units");
export const wakeFields = {
  wakeCause: wakeCauseSchema.optional(),
  wakeRef: wakeRefSchema.optional(),
};
export const storedWakeFields = {
  wakeCause: wakeCauseSchema.catch("unknown"),
  wakeRef: wakeRefSchema.nullable().catch(null),
};
export function readWake(value: { wakeCause?: unknown; wakeRef?: unknown }) {
  return z.object(storedWakeFields).parse(value);
}

export type EarliestAcceptedPrimaryWakeRef = string;

export interface WakeAttribution {
  wakeCause?: WakeCause;
  wakeRef?: EarliestAcceptedPrimaryWakeRef | null;
  retainedCause?: WakeCause;
  wakeSourcesTruncated?: boolean;
  wakeSources?: { wakeCause: WakeCause; wakeRef: string | null }[];
}
export function wakeAttribution(value: WakeAttribution) {
  const truncated =
    value.wakeSourcesTruncated === true ||
    (value.wakeSources?.length ?? 0) > 32;
  return {
    wakeCause: truncated
      ? ("unknown" as const)
      : wakeCauseSchema.parse(value.wakeCause ?? "unknown"),
    wakeRef:
      value.wakeRef == null ? undefined : wakeRefSchema.parse(value.wakeRef),
    ...(value.retainedCause === undefined
      ? {}
      : { retainedCause: wakeCauseSchema.parse(value.retainedCause) }),
    ...(value.wakeSourcesTruncated === undefined && !truncated
      ? {}
      : { wakeSourcesTruncated: truncated }),
    ...(value.wakeSources === undefined
      ? {}
      : {
          wakeSources: z
            .array(
              z.object({
                wakeCause: wakeCauseSchema,
                wakeRef: wakeRefSchema.nullable(),
              }),
            )
            .parse(value.wakeSources)
            .slice(0, 32),
        }),
  };
}

export const wakeProvenanceSchema = z.object({
  sources: z.array(z.object(storedWakeFields)).max(32),
  truncated: z.boolean(),
});
export function mergeWakeProvenance(
  previous: z.infer<typeof wakeProvenanceSchema> | null,
  next: WakeAttribution,
) {
  const normalized = wakeAttribution(next);
  const all = [
    ...(previous?.sources ?? []),
    ...(normalized.wakeSources?.length
      ? normalized.wakeSources
      : [readWake(normalized)]),
  ];
  const truncated =
    (previous?.truncated ?? false) ||
    normalized.wakeSourcesTruncated === true ||
    all.length > 32;
  const sources = all.slice(0, 32);
  const wakeCause =
    !truncated && new Set(sources.map((source) => source.wakeCause)).size === 1
      ? sources[0]!.wakeCause
      : "unknown";
  const wakeRef = sources[0]?.wakeRef ?? null;
  return { sources, truncated, wakeCause, wakeRef };
}
