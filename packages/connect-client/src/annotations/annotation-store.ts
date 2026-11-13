import { createHash } from "node:crypto";
import { z } from "zod";

import { pageAnnotationSchema, annotationUpdateSchema } from "./annotations.js";

export const annotationScopeSchema = z
  .object({
    hostId: z.string().min(1).max(256).optional(),
    port: z.number().int().min(1).max(65535),
    url: z
      .url()
      .max(4096)
      .refine((value) => /^https?:\/\//.test(value)),
  })
  .strict();
export const connectAnnotationSchema = pageAnnotationSchema
  .extend({
    author: z.literal("Owner"),
    capture: z
      .object({
        reason: z.literal(
          "Browser crop capture is unavailable in connect previews",
        ),
      })
      .strict(),
  })
  .strict();
export type ConnectAnnotation = z.infer<typeof connectAnnotationSchema>;
type Scope = z.infer<typeof annotationScopeSchema>;
export const annotationChangeSchema = z.discriminatedUnion("type", [
  z
    .object({ type: z.literal("annotation"), annotation: pageAnnotationSchema })
    .strict(),
  annotationUpdateSchema
    .extend({ type: z.literal("annotation-update") })
    .strict(),
  z
    .object({
      type: z.literal("annotation-delete"),
      id: z.string().min(1).max(64),
    })
    .strict(),
]);
export class AnnotationStore {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly kv: {
      get<T>(key: string): Promise<T | undefined>;
      set(key: string, value: unknown): Promise<void>;
    },
    private readonly requireShare: (
      port: number,
      scope: Scope,
    ) => void | Promise<void> = () => {},
  ) {}
  private key(scope: Scope): string {
    return `${scope.hostId === undefined ? "" : `host.${createHash("sha256").update(scope.hostId).digest("hex")}.`}annotations.v1.${scope.port}.${createHash("sha256").update(scope.url).digest("hex")}`;
  }
  async list(input: Scope): Promise<ConnectAnnotation[]> {
    const scope = annotationScopeSchema.parse(input);
    await this.requireShare(scope.port, scope);
    return z
      .array(connectAnnotationSchema)
      .parse((await this.kv.get(this.key(scope))) ?? []);
  }
  change(
    input: Scope,
    raw: z.infer<typeof annotationChangeSchema>,
  ): Promise<ConnectAnnotation[]> {
    const work = this.queue.then(async () => {
      const scope = annotationScopeSchema.parse(input);
      const change = annotationChangeSchema.parse(raw);
      const records = await this.list(scope);
      if (change.type === "annotation") {
        if (change.annotation.url !== scope.url)
          throw new Error("Page URL does not match");
        if (records.length >= 200)
          throw new Error("Page annotation limit reached");
        if (records.some((record) => record.id === change.annotation.id))
          throw new Error("Annotation already exists");
        records.push({
          ...change.annotation,
          number: Math.max(0, ...records.map((record) => record.number)) + 1,
          author: "Owner",
          capture: {
            reason: "Browser crop capture is unavailable in connect previews",
          },
        });
      } else {
        const index = records.findIndex((record) => record.id === change.id);
        if (index < 0) throw new Error("Annotation not found");
        if (change.type === "annotation-delete") records.splice(index, 1);
        else records[index] = { ...records[index]!, comment: change.comment };
      }
      await this.kv.set(this.key(scope), records);
      return records;
    });
    this.queue = work.catch(() => {});
    return work;
  }
}

export function requireDeclaredAnnotationShare(
  scope: Scope,
  shares: readonly {
    hostId: string;
    port: number;
    url: string;
    nextUrl?: string;
    unavailableReason?: string;
  }[],
): void {
  const share = shares.find(
    (entry) => entry.hostId === scope.hostId && entry.port === scope.port,
  );
  if (
    !share ||
    share.unavailableReason ||
    ![share.url, ...(share.nextUrl ? [share.nextUrl] : [])].some(
      (url) => new URL(url).origin === new URL(scope.url).origin,
    )
  )
    throw new Error("This host page is not shared");
}
