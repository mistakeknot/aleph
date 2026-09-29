import { useEffect, useRef } from "react";
import type { FollowUpSubmitMode } from "@bb/client-core";
import type { BbDesktopDiagnosticComposerSendState } from "@bb/desktop-contract";
import { emitDiagnostic, toDiagnosticReason } from "@/lib/diagnostics";

interface DescribeComposerSendStateArgs {
  isFollowUpSubmitting: boolean;
  submitMode: FollowUpSubmitMode;
}

export function describeComposerSendState({
  isFollowUpSubmitting,
  submitMode,
}: DescribeComposerSendStateArgs): BbDesktopDiagnosticComposerSendState {
  if (submitMode.kind === "blocked") {
    return `blocked-${submitMode.reason}`;
  }
  if (isFollowUpSubmitting) {
    return "submitting";
  }
  return submitMode.kind;
}

interface UseComposerSendStateDiagnosticArgs extends DescribeComposerSendStateArgs {
  runtimeStatus: string | null;
  threadId: string;
}

interface LastLoggedState {
  state: BbDesktopDiagnosticComposerSendState;
  threadId: string;
}

export function useComposerSendStateDiagnostic({
  isFollowUpSubmitting,
  runtimeStatus,
  submitMode,
  threadId,
}: UseComposerSendStateDiagnosticArgs): void {
  const lastLogged = useRef<LastLoggedState | null>(null);
  const state = describeComposerSendState({ isFollowUpSubmitting, submitMode });
  useEffect(() => {
    const previous = lastLogged.current;
    if (previous?.threadId === threadId && previous.state === state) {
      return;
    }
    lastLogged.current = { state, threadId };
    emitDiagnostic(() => ({
      kind: "composer-send-state",
      previous: previous?.threadId === threadId ? previous.state : null,
      runtimeStatus: toDiagnosticReason(runtimeStatus),
      state,
      threadId,
    }));
  }, [runtimeStatus, state, threadId]);
}
