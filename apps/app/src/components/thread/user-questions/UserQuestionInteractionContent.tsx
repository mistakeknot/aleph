import { useMemo } from "react";
import type { PendingInteractionUserQuestionQuestion } from "@bb/domain";
import { QuestionForm } from "@bb/shared-ui/question-form";
import { clearQuestionFormDraft } from "@bb/shared-ui/question-form-state";
import { useResolveThreadPendingInteraction } from "@/hooks/mutations/thread-interaction-mutations";
import { useStopThread } from "@/hooks/mutations/thread-runtime-mutations";
import { getMutationErrorMessage } from "@/lib/mutation-errors";

interface UserQuestionAnswerFormProps {
  interactionId: string;
  isResolving: boolean;
  questions: readonly PendingInteractionUserQuestionQuestion[];
  threadId: string;
}

export function UserQuestionAnswerForm({
  interactionId,
  isResolving,
  questions,
  threadId,
}: UserQuestionAnswerFormProps) {
  const normalizedQuestions = useMemo(
    () =>
      questions.map((question, index) => ({
        ...question,
        shortLabel: question.shortLabel ?? `Question ${index + 1}`,
        options: question.options ?? [],
      })),
    [questions],
  );
  const resolvePendingInteraction =
    useResolveThreadPendingInteraction(threadId);
  const stopThread = useStopThread();
  const disabled = resolvePendingInteraction.isPending || isResolving;
  const error = resolvePendingInteraction.error
    ? getMutationErrorMessage({
        error: resolvePendingInteraction.error,
        fallbackMessage: "Failed to submit answer",
        lifecycleOperation: "resolve_interaction",
      })
    : null;
  const draftKey = `${threadId}:${interactionId}`;
  return (
    <div>
      <QuestionForm
        key={interactionId}
        draftKey={draftKey}
        questions={normalizedQuestions}
        disabled={disabled}
        cancelDisabled={disabled || stopThread.isPending}
        onSubmit={(answers) => {
          void resolvePendingInteraction
            .mutateAsync({
              threadId,
              interactionId,
              resolution: { kind: "user_answer", answers },
            })
            .then(() => clearQuestionFormDraft(draftKey))
            .catch(() => {});
        }}
        onCancel={() => {
          void stopThread
            .mutateAsync(threadId)
            .then(() => clearQuestionFormDraft(draftKey))
            .catch(() => {});
        }}
      />
      {error ? (
        <div className="mt-2 shrink-0 rounded-md border border-surface-destructive-border bg-surface-destructive px-3 py-2 text-xs text-destructive-text">
          {error}
        </div>
      ) : null}
    </div>
  );
}
