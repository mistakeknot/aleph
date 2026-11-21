import { eq } from "drizzle-orm";
import { promptCacheTtlSchema } from "@bb/domain";
import type { DbConnection } from "../connection.js";
import { threads } from "../schema.js";

export function getThreadPromptCacheTtl(db: DbConnection, threadId: string) {
  const row = db
    .select({ value: threads.promptCacheTtl })
    .from(threads)
    .where(eq(threads.id, threadId))
    .get();
  return row?.value == null ? undefined : promptCacheTtlSchema.parse(row.value);
}

export function setThreadPromptCacheTtl(
  db: DbConnection,
  threadId: string,
  value: "5m" | "1h",
) {
  db.update(threads)
    .set({ promptCacheTtl: value })
    .where(eq(threads.id, threadId))
    .run();
}
