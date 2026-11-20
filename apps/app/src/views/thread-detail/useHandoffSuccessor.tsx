import { useEffect, useState } from "react";
import { z } from "zod";
import {
  arePromptDraftStatesEqual,
  isPromptDraftEmpty,
  type PromptDraftState,
} from "@bb/client-core";
import { getPromptDraftAccessor } from "@/hooks/usePromptDraftStorage";
import { useServerConnectionState } from "@/hooks/useServerConnectionState";
import { callPluginRpc } from "@/lib/plugin-sdk-hooks";
import { wsManager } from "@/lib/ws";
import type { ThreadRoutePathArgs } from "@/lib/route-paths";

const successorSchema = z
  .object({
    threadId: z.string().min(1),
    projectId: z.string().min(1),
    title: z.string().nullable(),
  })
  .nullable();

export async function lookupHandoffSuccessor(threadId: string) {
  return successorSchema.parse(
    await callPluginRpc(fetch, "handoff", "resolveSuccessor", { threadId }),
  );
}

type Notice = {
  from: string;
  to: string;
  carriedDraft: boolean;
  sourceId: string;
  targetId: string;
};
const carriedDrafts = new Map<string, PromptDraftState>();
const localSwitchListeners = new Set<
  (sourceId: string, target: ThreadRoutePathArgs) => boolean
>();

export function followLocalHandoff(
  sourceId: string,
  target: ThreadRoutePathArgs,
): boolean {
  let handled = false;
  for (const listener of localSwitchListeners)
    handled = listener(sourceId, target) || handled;
  return handled;
}

export function HandoffNotice({
  notice,
  onDismiss,
}: {
  notice: Notice | null;
  onDismiss: () => void;
}) {
  if (!notice) return null;
  return (
    <div
      role="status"
      className="flex items-center gap-2 px-3 py-1 text-xs text-muted-foreground"
    >
      <span className="min-w-0 truncate">
        Followed handoff: {notice.from} → {notice.to}
        {notice.carriedDraft ? " · Draft carried" : ""}
      </span>
      <button
        type="button"
        aria-label="Dismiss handoff notice"
        className="rounded px-2 py-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={onDismiss}
      >
        ×
      </button>
    </div>
  );
}

export function useHandoffSuccessor(
  args: ThreadRoutePathArgs & {
    title: string | null | undefined;
    archivedAt: number | null | undefined;
    navigateInPane: (target: ThreadRoutePathArgs) => void;
  },
) {
  const { threadId, projectId, title, archivedAt, navigateInPane } = args;
  const connection = useServerConnectionState();
  const [notice, setNotice] = useState<Notice | null>(null);
  useEffect(() => {
    let disposed = false;
    const generation = { current: 0 };
    let followed = false;
    const follow = (target: NonNullable<z.infer<typeof successorSchema>>) => {
      if (
        disposed ||
        followed ||
        target.threadId === threadId ||
        target.projectId !== projectId
      )
        return;
      const sourceDraft = getPromptDraftAccessor({
        kind: "thread",
        projectId,
        threadId,
      }).getCurrent();
      const targetDraft = getPromptDraftAccessor({
        kind: "thread",
        projectId: target.projectId,
        threadId: target.threadId,
      });
      const existing = targetDraft.getCurrent();
      const carriedDraft = !isPromptDraftEmpty(sourceDraft);
      const carryKey = JSON.stringify([projectId, threadId, target.threadId]);
      const previousCarry = carriedDrafts.get(carryKey);
      if (
        carriedDraft &&
        !(
          previousCarry && arePromptDraftStatesEqual(previousCarry, sourceDraft)
        ) &&
        !arePromptDraftStatesEqual(sourceDraft, existing)
      ) {
        const prefix = existing.text ? `${existing.text}\n\n` : "";
        targetDraft.setDraft({
          text: prefix + sourceDraft.text,
          mentions: [
            ...existing.mentions,
            ...sourceDraft.mentions.map((mention) => ({
              ...mention,
              start: mention.start + prefix.length,
              end: mention.end + prefix.length,
            })),
          ],
          attachments: [
            ...existing.attachments,
            ...sourceDraft.attachments.filter(
              (attachment) =>
                !existing.attachments.some(
                  (item) =>
                    item.path === attachment.path &&
                    item.hostId === attachment.hostId &&
                    item.sourceProjectId === attachment.sourceProjectId,
                ),
            ),
          ],
        });
      }
      if (carriedDraft) carriedDrafts.set(carryKey, sourceDraft);
      followed = true;
      setNotice({
        from: title || threadId,
        to: target.title || target.threadId,
        carriedDraft,
        sourceId: threadId,
        targetId: target.threadId,
      });
      navigateInPane({
        threadId: target.threadId,
        projectId: target.projectId,
      });
    };
    const localSwitch = (sourceId: string, target: ThreadRoutePathArgs) => {
      if (sourceId !== threadId || target.projectId !== projectId) return false;
      follow({ ...target, title: null });
      return true;
    };
    localSwitchListeners.add(localSwitch);
    const refresh = () => {
      const current = ++generation.current;
      void lookupHandoffSuccessor(threadId)
        .then((target) => {
          if (current === generation.current && target) follow(target);
        })
        .catch(() => {});
    };
    const unsubscribe = wsManager.onPluginSignal((event) => {
      if (event.pluginId === "handoff" && event.channel === "handoff:replaced")
        void refresh();
    });
    const target = { kind: "plugin", pluginId: "handoff" } as const;
    wsManager.subscribe(target);
    void refresh();
    return () => {
      disposed = true;
      localSwitchListeners.delete(localSwitch);
      unsubscribe();
      wsManager.unsubscribe(target);
    };
  }, [threadId, projectId, title, archivedAt, navigateInPane, connection]);
  return {
    notice:
      notice && (notice.sourceId === threadId || notice.targetId === threadId)
        ? notice
        : null,
    dismiss: () => setNotice(null),
  };
}
