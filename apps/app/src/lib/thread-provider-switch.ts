import type { PromptDraftState } from "@bb/client-core";
import type { ReasoningLevel } from "@bb/domain";
import { callPluginRpc } from "@/lib/plugin-sdk-hooks";
import type { PluginListItem } from "@/hooks/queries/plugin-settings-queries";

export const THREAD_SWITCH_PLUGIN_ID = "handoff";

export const THREAD_SWITCH_ATTACHMENTS_ERROR =
  "Attachments can't travel with a switch — send them after it.";

export type ThreadHandoffTarget = "switch" | "new-thread";

export function isThreadSwitchAvailable(
  plugins: readonly Pick<PluginListItem, "id" | "enabled" | "status">[],
): boolean {
  return plugins.some(
    (plugin) =>
      plugin.id === THREAD_SWITCH_PLUGIN_ID &&
      plugin.enabled &&
      plugin.status === "running",
  );
}

export class ThreadSwitchAttachmentsError extends Error {
  constructor() {
    super(THREAD_SWITCH_ATTACHMENTS_ERROR);
    this.name = "ThreadSwitchAttachmentsError";
  }
}

export async function switchThreadProvider(
  fetchImpl: typeof fetch,
  args: {
    threadId: string;
    providerId: string;
    model: string;
    reasoningLevel: ReasoningLevel;
    draft: PromptDraftState;
  },
): Promise<{ newThreadId: string }> {
  if (args.draft.attachments.length > 0) {
    throw new ThreadSwitchAttachmentsError();
  }
  const message = args.draft.text.trim();
  const result = (await callPluginRpc(
    fetchImpl,
    THREAD_SWITCH_PLUGIN_ID,
    "startHandoff",
    {
      threadId: args.threadId,
      providerId: args.providerId,
      model: args.model,
      reasoningLevel: args.reasoningLevel,
      workspace: "reuse",
      replace: true,
      ...(message.length > 0 ? { message } : {}),
    },
  )) as { newThreadId?: unknown } | null;
  if (typeof result?.newThreadId !== "string") {
    throw new Error("The handoff plugin did not return the new thread.");
  }
  return { newThreadId: result.newThreadId };
}
