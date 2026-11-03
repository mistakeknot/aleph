import { useEffect, useRef, useState } from "react";
import {
  experimental_useRpcMutation as useRpcMutation,
  experimental_useRpcQuery as useRpcQuery,
} from "@get-bb/plugin-sdk/app";
import {
  designWikiRpcContract,
  type AnswerPinDecisionResult,
  type PinDecisionItem,
} from "../contract.js";
import { BUTTON } from "./button-class.js";
import { openCard } from "./open-card.js";

export const PIN_DECISIONS_REFRESH_MS = 30_000;

type Failure = Extract<AnswerPinDecisionResult, { ok: false }>;

const UNKNOWN: Failure = {
  ok: false,
  reason: "unknown",
  message:
    "Could not confirm whether Citadel took the answer. Check the card before answering again.",
};

export interface DecisionActions {
  decisionsFor: (pinId: string) => PinDecisionItem[];
  answerDecision: (input: {
    pinId: string;
    key: string;
    optionId: string;
    revision: string;
  }) => Promise<AnswerPinDecisionResult>;
  openDecisionCard: (key: string) => void;
}

export function usePinDecisions(projectId: string): DecisionActions {
  const query = useRpcQuery({
    contract: designWikiRpcContract,
    method: "pinDecisions",
    input: { projectId },
  });
  const answer = useRpcMutation({
    contract: designWikiRpcContract,
    method: "answerPinDecision",
  });
  const items = query.data ?? [];
  const holdsCards = items.length > 0;
  const refetch = useRef(query.refetch);

  useEffect(() => {
    refetch.current = query.refetch;
  });

  useEffect(() => {
    const reread = () => void refetch.current();
    const onVisible = () => {
      if (document.visibilityState === "visible") reread();
    };
    window.addEventListener("focus", reread);
    document.addEventListener("visibilitychange", onVisible);
    const timer = holdsCards
      ? window.setInterval(reread, PIN_DECISIONS_REFRESH_MS)
      : null;
    return () => {
      window.removeEventListener("focus", reread);
      document.removeEventListener("visibilitychange", onVisible);
      if (timer !== null) window.clearInterval(timer);
    };
  }, [holdsCards]);

  return {
    decisionsFor: (pinId) => items.filter((item) => item.pinId === pinId),
    answerDecision: async (input) => {
      let result: AnswerPinDecisionResult;
      try {
        result = await answer.mutate({
          projectId,
          ...input,
          pickId: crypto.randomUUID(),
        });
      } catch {
        result = UNKNOWN;
      }
      await Promise.resolve(query.refetch()).catch(() => undefined);
      return result;
    },
    openDecisionCard: openCard,
  };
}

function stateLabel(item: PinDecisionItem): string | null {
  if (item.state === "closed") {
    const detail = item.cardState?.replace(/[_-]+/g, " ").trim() ?? "";
    return detail === "" ? "Closed" : `Closed (${detail})`;
  }
  return null;
}

function DecisionItem(props: {
  item: PinDecisionItem;
  actions: DecisionActions;
}) {
  const { item, actions } = props;
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [unsure, setUnsure] = useState<string | null>(null);
  const answer = item.answer;
  const held = unsure !== null && answer !== null && answer.revision === unsure;
  const label = stateLabel(item);

  const pick = async (optionId: string, revision: string) => {
    setBusy(true);
    setFailure(null);
    try {
      const result = await actions.answerDecision({
        pinId: item.pinId,
        key: item.key,
        optionId,
        revision,
      });
      setFailure(result.ok ? null : result);
      setUnsure(!result.ok && result.reason === "unknown" ? revision : null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <li
      data-pin-decision={item.key}
      className="flex flex-col gap-1 rounded-md bg-muted/40 p-1.5 text-xs"
    >
      <div className="flex flex-wrap items-center gap-2">
        {item.state === "missing" ? (
          <span className="font-mono text-subtle-foreground">{item.key}</span>
        ) : (
          <button
            type="button"
            className={BUTTON}
            aria-label={`Open ${item.key}`}
            onClick={() => actions.openDecisionCard(item.key)}
          >
            {item.key}
          </button>
        )}
        {item.title === null ? null : (
          <span className="min-w-0 break-words">{item.title}</span>
        )}
        {label === null ? null : (
          <span className="rounded-full border border-border px-2 leading-5">
            {label}
          </span>
        )}
      </div>
      {answer === null ? null : (
        <div className="flex flex-col gap-1">
          <p className="break-words">{answer.question}</p>
          {answer.recommendation === null ? null : (
            <p className="text-subtle-foreground">
              {`Recommended: ${
                answer.options.find(
                  (option) => option.id === answer.recommendation,
                )?.label ?? answer.recommendation
              }`}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            {answer.options.map((option) => (
              <button
                key={option.id}
                type="button"
                className={BUTTON}
                disabled={busy || held}
                aria-label={`Answer ${item.key}: ${option.label}`}
                onClick={() => void pick(option.id, answer.revision)}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
      )}
      {held ? (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className={BUTTON}
            aria-label={`Open card ${item.key}`}
            onClick={() => actions.openDecisionCard(item.key)}
          >
            Open card
          </button>
        </div>
      ) : null}
      {item.reason === null ? null : (
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-subtle-foreground">{item.reason}</p>
          {item.state === "open" ? (
            <button
              type="button"
              className={BUTTON}
              aria-label={`Open card ${item.key}`}
              onClick={() => actions.openDecisionCard(item.key)}
            >
              Open card
            </button>
          ) : null}
        </div>
      )}
      {failure === null ? null : (
        <p role="status" className="text-subtle-foreground">
          {failure.message}
        </p>
      )}
    </li>
  );
}

export function PinDecisions(props: {
  pinId: string;
  actions: DecisionActions;
}) {
  const items = props.actions.decisionsFor(props.pinId);
  if (items.length === 0) return null;
  return (
    <ul aria-label="Decisions" className="flex flex-col gap-1">
      {items.map((item) => (
        <DecisionItem key={item.key} item={item} actions={props.actions} />
      ))}
    </ul>
  );
}
