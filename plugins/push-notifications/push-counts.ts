import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const pushCountsSchema = z
  .object({
    question: z.number().int().nonnegative(),
    "turn-end": z.number().int().nonnegative(),
    error: z.number().int().nonnegative(),
    firstAt: z.number().int().nonnegative().nullable(),
    lastAt: z.number().int().nonnegative().nullable(),
  })
  .strict();
export type PushCounts = z.infer<typeof pushCountsSchema>;
export type PushTrigger = "question" | "turn-end" | "error";

export function createPushCounts(bb: BbPluginApi) {
  let queue: Promise<unknown> = Promise.resolve();
  function serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = queue.then(operation, operation);
    queue = result.catch(() => undefined);
    return result;
  }
  async function read(threadId: string): Promise<PushCounts> {
    const stored = await bb.storage.kv.get<unknown>(`push-count:${threadId}`);
    return stored === undefined
      ? { question: 0, "turn-end": 0, error: 0, firstAt: null, lastAt: null }
      : pushCountsSchema.parse(stored);
  }
  return {
    get(threadId: string): Promise<PushCounts> {
      return serialize(() => read(threadId));
    },
    record(threadId: string, trigger: PushTrigger, at: number): Promise<void> {
      return serialize(async () => {
        const row = await read(threadId);
        row[trigger] += 1;
        row.firstAt = Math.min(row.firstAt ?? at, at);
        row.lastAt = Math.max(row.lastAt ?? at, at);
        await bb.storage.kv.set(
          `push-count:${threadId}`,
          pushCountsSchema.parse(row),
        );
      });
    },
  };
}
