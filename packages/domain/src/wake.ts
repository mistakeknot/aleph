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

export interface WakeAttribution {
  wakeCause?: WakeCause;
  wakeRef?: string | null;
  retainedCause?: WakeCause;
  wakeSourcesTruncated?: boolean;
  wakeSources?: { wakeCause: WakeCause; wakeRef: string | null }[];
}
export function wakeAttribution(value: WakeAttribution) {
  return {
    wakeCause: wakeCauseSchema.parse(value.wakeCause ?? "unknown"),
    wakeRef:
      value.wakeRef == null ? undefined : wakeRefSchema.parse(value.wakeRef),
    ...(value.retainedCause === undefined
      ? {}
      : { retainedCause: wakeCauseSchema.parse(value.retainedCause) }),
    ...(value.wakeSourcesTruncated === undefined
      ? {}
      : { wakeSourcesTruncated: value.wakeSourcesTruncated }),
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
            .parse(value.wakeSources),
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
  const all = [...(previous?.sources ?? []), readWake(wakeAttribution(next))];
  const truncated = (previous?.truncated ?? false) || all.length > 32;
  const sources = all.slice(0, 32);
  const wakeCause =
    !truncated && new Set(sources.map((source) => source.wakeCause)).size === 1
      ? sources[0]!.wakeCause
      : "unknown";
  const wakeRef =
    !truncated && new Set(sources.map((source) => source.wakeRef)).size === 1
      ? sources[0]!.wakeRef
      : null;
  return { sources, truncated, wakeCause, wakeRef };
}
