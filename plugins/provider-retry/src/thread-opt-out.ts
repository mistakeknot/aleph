import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { listQueuedRetries } from "./queued-retries.js";

/**
 * Per-thread opt-out, for a caller that owns retries itself.
 *
 * An orchestrator that dispatches a thread and applies its own retry and
 * fallback policy needs to be the only thing re-attempting that thread's
 * turns; a second, independent retrier would re-run work the caller has
 * already accounted as failed. Kept in this plugin's kv, like the account
 * pool's per-thread bypass: only this plugin writes it, and the `turn.failed`
 * handler reads one row.
 */
function disabledKey(threadId: string): string {
  return `retries-disabled:${threadId}`;
}

export async function retriesDisabled(
  bb: BbPluginApi,
  threadId: string,
): Promise<boolean> {
  return (await bb.storage.kv.get<true>(disabledKey(threadId))) === true;
}

/**
 * Stop retrying this thread's turns, and cancel any retry already queued.
 *
 * The cancel closes the window between spawning a thread and disabling it: a
 * turn that failed in between may already have a retry waiting on its reset.
 * Returns how many queued retries were cancelled.
 */
export async function disableRetries(
  bb: BbPluginApi,
  threadId: string,
): Promise<number> {
  await bb.storage.kv.set(disabledKey(threadId), true);
  const queued = await listQueuedRetries(bb, threadId);
  for (const retry of queued) {
    await bb.sdk.threads.queuedMessages.delete({
      threadId: retry.threadId,
      queuedMessageId: retry.id,
    });
  }
  return queued.length;
}

export async function enableRetries(
  bb: BbPluginApi,
  threadId: string,
): Promise<void> {
  await bb.storage.kv.delete(disabledKey(threadId));
}
