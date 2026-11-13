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
      const key = this.key(scope);
      const share = createHash("sha256")
        .update(JSON.stringify([scope.hostId ?? null, scope.port]))
        .digest("hex");
      const bytes = Buffer.byteLength(JSON.stringify(records));
      if (bytes > 192 * 1024)
        throw new Error("Page annotation byte limit reached");
      const indexKey = "annotations.index.v1";
      const index = z
        .object({
          pages: z.record(
            z.string(),
            z.object({ share: z.string(), bytes: z.number().nonnegative() }),
          ),
          rates: z.record(
            z.string(),
            z.object({ start: z.number(), count: z.number() }),
          ),
        })
        .parse((await this.kv.get(indexKey)) ?? { pages: {}, rates: {} });
      const previous = index.pages[key];
      const reservation = Math.max(previous?.bytes ?? 0, bytes);
      const pages = Object.values(index.pages);
      const own = pages.filter((page) => page.share === share);
      if (!previous && (pages.length >= 1024 || own.length >= 64))
        throw new Error("Annotation page quota reached");
      const growth = reservation - (previous?.bytes ?? 0);
      if (
        pages.reduce((sum, page) => sum + page.bytes, 0) + growth >
          32 * 1024 * 1024 ||
        own.reduce((sum, page) => sum + page.bytes, 0) + growth >
          2 * 1024 * 1024
      )
        throw new Error("Annotation storage quota reached");
      const now = Date.now();
      const rate = index.rates[share];
      if (rate && now - rate.start < 60000 && rate.count >= 60)
        throw new Error("Annotation write rate exceeded");
      index.rates[share] =
        rate && now - rate.start < 60000
          ? { start: rate.start, count: rate.count + 1 }
          : { start: now, count: 1 };
      index.pages[key] = { share, bytes: reservation };
      if (Buffer.byteLength(JSON.stringify(index)) > 240 * 1024)
        throw new Error("Annotation index quota reached");
      await this.kv.set(indexKey, index);
      await this.kv.set(key, records);
      if (bytes < reservation) {
        index.pages[key] = { share, bytes };
        await this.kv.set(indexKey, index);
      }
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
