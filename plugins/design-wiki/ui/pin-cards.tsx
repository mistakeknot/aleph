import { useEffect, useRef, useState } from "react";
import {
  experimental_useRpcMutation as useRpcMutation,
  experimental_useRpcQuery as useRpcQuery,
} from "@get-bb/plugin-sdk/app";
import {
  designWikiRpcContract,
  type PinTaskItem,
  type PinTaskResult,
  type TaskBoard,
} from "../contract.js";
import { BUTTON } from "./button-class.js";
import { openCard } from "./open-card.js";

export const PIN_TASKS_REFRESH_MS = 30_000;

type Failure = Extract<PinTaskResult, { ok: false }>;

const UNREACHABLE: Failure = {
  ok: false,
  reason: "tasks-unavailable",
  message: "Could not reach the task board. Try again.",
};

export interface CardActions {
  cardsFor: (pinId: string) => PinTaskItem[];
  makeCard: (pinId: string, taskProjectId?: string) => Promise<PinTaskResult>;
  linkCard: (pinId: string, taskKey: string) => Promise<PinTaskResult>;
  unlinkCard: (pinId: string, taskId: string) => Promise<boolean>;
  openCard: (key: string) => void;
  openThread: (threadId: string) => void;
}

export function usePinCards(
  projectId: string,
  openThread: (threadId: string) => void,
): CardActions {
  const query = useRpcQuery({
    contract: designWikiRpcContract,
    method: "pinTasks",
    input: { projectId },
  });
  const createPinTask = useRpcMutation({
    contract: designWikiRpcContract,
    method: "createPinTask",
  });
  const linkPinTask = useRpcMutation({
    contract: designWikiRpcContract,
    method: "linkPinTask",
  });
  const unlinkPinTask = useRpcMutation({
    contract: designWikiRpcContract,
    method: "unlinkPinTask",
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
      ? window.setInterval(reread, PIN_TASKS_REFRESH_MS)
      : null;
    return () => {
      window.removeEventListener("focus", reread);
      document.removeEventListener("visibilitychange", onVisible);
      if (timer !== null) window.clearInterval(timer);
    };
  }, [holdsCards]);

  return {
    cardsFor: (pinId) => items.filter((item) => item.pinId === pinId),
    makeCard: async (pinId, taskProjectId) => {
      try {
        const result = await createPinTask.mutate({
          projectId,
          pinId,
          ...(taskProjectId === undefined ? {} : { taskProjectId }),
        });
        await query.refetch();
        return result;
      } catch {
        return UNREACHABLE;
      }
    },
    linkCard: async (pinId, taskKey) => {
      try {
        const result = await linkPinTask.mutate({ projectId, pinId, taskKey });
        await query.refetch();
        return result;
      } catch {
        return UNREACHABLE;
      }
    },
    unlinkCard: async (pinId, taskId) => {
      try {
        await unlinkPinTask.mutate({ projectId, pinId, taskId });
        await query.refetch();
        return true;
      } catch {
        return false;
      }
    },
    openCard,
    openThread,
  };
}

function statusLabel(status: string): string {
  const words = status.replace(/[_-]+/g, " ").trim();
  return words === "" ? status : words[0]!.toUpperCase() + words.slice(1);
}

function unavailableNote(count: number): string {
  return count === 1
    ? "1 thread is unavailable"
    : `${count} threads are unavailable`;
}

function CardItem(props: {
  item: PinTaskItem;
  actions: CardActions;
  onUnlink: (item: PinTaskItem) => Promise<void>;
}) {
  const { item, actions } = props;
  const removed = item.state === "removed";
  return (
    <li
      data-pin-task={item.taskId}
      className="flex flex-col gap-1 rounded-md bg-muted/40 p-1.5 text-xs"
    >
      <div className="flex flex-wrap items-center gap-2">
        {removed ? (
          <span className="font-mono text-subtle-foreground">{item.key}</span>
        ) : (
          <button
            type="button"
            className={BUTTON}
            aria-label={`Open ${item.key}`}
            onClick={() => actions.openCard(item.key)}
          >
            {item.key}
          </button>
        )}
        {removed ? (
          <span className="font-medium text-destructive-text">
            Card removed
          </span>
        ) : null}
        {item.title === null ? null : (
          <span className="min-w-0 break-words">{item.title}</span>
        )}
        {item.status === null ? null : (
          <span className="rounded-full border border-border px-2 leading-5">
            {statusLabel(item.status)}
          </span>
        )}
        <button
          type="button"
          className={BUTTON}
          aria-label={`Unlink ${item.key}`}
          onClick={() => void props.onUnlink(item)}
        >
          Unlink
        </button>
      </div>
      {item.message === null ? null : (
        <p className="text-subtle-foreground">{item.message}</p>
      )}
      {item.threads.map((thread) => (
        <div
          key={thread.threadId}
          className="flex flex-wrap items-center gap-2"
        >
          <span className="text-subtle-foreground">Thread</span>
          <button
            type="button"
            className={BUTTON}
            aria-label={`Open thread ${thread.title}`}
            onClick={() => actions.openThread(thread.threadId)}
          >
            {thread.title}
          </button>
          <span className="text-subtle-foreground">{thread.liveStatus}</span>
        </div>
      ))}
      {item.pullRequests.map((pr) => (
        <div key={pr.url} className="flex flex-wrap items-center gap-2">
          <span className="text-subtle-foreground">Pull request</span>
          <a
            href={pr.url}
            target="_blank"
            rel="noreferrer"
            className="underline"
          >
            {`#${pr.number} ${pr.title}`}
          </a>
          <span className="text-subtle-foreground">{pr.state}</span>
        </div>
      ))}
      {item.unavailableThreadIds.length === 0 ? null : (
        <p className="text-subtle-foreground">
          {unavailableNote(item.unavailableThreadIds.length)}
        </p>
      )}
    </li>
  );
}

function BoardChoice(props: {
  boards: TaskBoard[];
  busy: boolean;
  onPick: (board: TaskBoard) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {props.boards.map((board) => (
        <button
          key={board.id}
          type="button"
          className={BUTTON}
          disabled={props.busy}
          onClick={() => props.onPick(board)}
        >
          {`Make task on ${board.name} (${board.prefix})`}
        </button>
      ))}
    </div>
  );
}

export function PinCards(props: { pinId: string; actions: CardActions }) {
  const { pinId, actions } = props;
  const cards = actions.cardsFor(pinId);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [linking, setLinking] = useState(false);
  const [key, setKey] = useState("");

  const settle = (result: PinTaskResult) => {
    if (result.ok) {
      setFailure(null);
      setLinking(false);
      setKey("");
      return;
    }
    setFailure(result);
    if (result.reason === "not-linked" && result.task !== undefined) {
      setKey(result.task.key);
      setLinking(true);
    }
  };

  const run = async (work: () => Promise<PinTaskResult>) => {
    setBusy(true);
    try {
      settle(await work());
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-1.5">
      {cards.length === 0 ? null : (
        <ul aria-label="Cards" className="flex flex-col gap-1">
          {cards.map((item) => (
            <CardItem
              key={item.taskId}
              item={item}
              actions={actions}
              onUnlink={async (target) => {
                setFailure(
                  (await actions.unlinkCard(pinId, target.taskId))
                    ? null
                    : UNREACHABLE,
                );
              }}
            />
          ))}
        </ul>
      )}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className={BUTTON}
          disabled={busy}
          onClick={() => void run(() => actions.makeCard(pinId))}
        >
          Make task
        </button>
        {linking ? null : (
          <button
            type="button"
            className={BUTTON}
            onClick={() => setLinking(true)}
          >
            Link existing card
          </button>
        )}
      </div>
      {failure === null ? null : (
        <p role="status" className="text-xs text-subtle-foreground">
          {failure.message}
        </p>
      )}
      {failure?.reason === "board-required" && failure.boards !== undefined ? (
        <BoardChoice
          boards={failure.boards}
          busy={busy}
          onPick={(board) => void run(() => actions.makeCard(pinId, board.id))}
        />
      ) : null}
      {linking ? (
        <div className="flex flex-wrap items-center gap-2">
          <input
            aria-label="Card key"
            value={key}
            onChange={(event) => setKey(event.target.value)}
            className="w-32 rounded-md border border-border bg-background px-2 py-0.5 text-xs"
          />
          <button
            type="button"
            className={BUTTON}
            disabled={busy || key.trim() === ""}
            onClick={() => void run(() => actions.linkCard(pinId, key.trim()))}
          >
            Link card
          </button>
          <button
            type="button"
            className={BUTTON}
            onClick={() => {
              setLinking(false);
              setKey("");
              setFailure(null);
            }}
          >
            Cancel
          </button>
        </div>
      ) : null}
    </div>
  );
}
