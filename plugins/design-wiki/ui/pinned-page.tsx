import { useMemo, useState } from "react";
import {
  experimental_useRpcMutation as useRpcMutation,
  experimental_useRpcQuery as useRpcQuery,
  useBbNavigate,
} from "@get-bb/plugin-sdk/app";
import { cn } from "@/lib/utils";
import { extractClaimSites } from "../claims.js";
import { designWikiRpcContract, type Pin } from "../contract.js";
import { type ClaimTarget, claimTargetAt } from "../pin-anchor.js";
import type { WikiPage } from "../wiki-types.js";
import { BUTTON } from "./button-class.js";
import { type CardActions, PinCards, usePinCards } from "./pin-cards.js";
import {
  type DecisionActions,
  PinDecisions,
  usePinDecisions,
} from "./pin-decisions.js";
import { type ClaimLayer, WikiPageView } from "./wiki-page-view.js";

const REASON_MESSAGE: Record<string, string> = {
  "stale-claim":
    "That claim changed on the page. Reopen the page and pin it again.",
  "unknown-claim": "That claim is no longer on the page.",
  "page-missing": "That page no longer exists.",
  unverified: "The page could not be checked right now. Try again.",
  "invalid-body": "The note is empty or too long.",
  "not-found": "That pin no longer exists.",
  "thread-not-found": "That thread no longer exists.",
  "wrong-project": "That thread belongs to a different project.",
};

const FAILED = "Could not save the pin. Try again.";

function reasonMessage(reason: string): string {
  return REASON_MESSAGE[reason] ?? FAILED;
}

function claimKey(target: ClaimTarget): string {
  return JSON.stringify([
    target.label,
    target.context,
    target.ordinal,
    target.groupSize,
  ]);
}

export interface PinActions extends CardActions, DecisionActions {
  projectId: string;
  threadId: string | null;
  message: string | null;
  setMessage: (message: string | null) => void;
  create: (input: {
    pageId: string;
    claim: ClaimTarget | null;
    body: string;
  }) => Promise<Pin | null>;
  update: (input: {
    pinId: string;
    body?: string;
    resolved?: boolean;
  }) => Promise<boolean>;
  remove: (pinId: string) => Promise<void>;
  discuss: (pin: Pin, title: string | null) => Promise<void>;
}

export function usePinActions(
  projectId: string,
  threadId: string | null,
): PinActions {
  const navigate = useBbNavigate();
  const [message, setMessage] = useState<string | null>(null);
  const createPin = useRpcMutation({
    contract: designWikiRpcContract,
    method: "createPin",
  });
  const updatePin = useRpcMutation({
    contract: designWikiRpcContract,
    method: "updatePin",
  });
  const deletePin = useRpcMutation({
    contract: designWikiRpcContract,
    method: "deletePin",
  });
  const linkPinThread = useRpcMutation({
    contract: designWikiRpcContract,
    method: "linkPinThread",
  });
  const openThread = (id: string) => navigate.toThread(id);
  const cards = usePinCards(projectId, openThread);
  const decisions = usePinDecisions(projectId);

  return {
    ...cards,
    ...decisions,
    projectId,
    threadId,
    message,
    setMessage,
    create: async (input) => {
      setMessage(null);
      try {
        const result = await createPin.mutate({ projectId, ...input });
        if (result.ok) return result.pin;
        setMessage(reasonMessage(result.reason));
      } catch {
        setMessage(FAILED);
      }
      return null;
    },
    update: async (input) => {
      setMessage(null);
      try {
        const result = await updatePin.mutate({ projectId, ...input });
        if (result.ok) return true;
        setMessage(reasonMessage(result.reason));
      } catch {
        setMessage(FAILED);
      }
      return false;
    },
    remove: async (pinId) => {
      setMessage(null);
      try {
        await deletePin.mutate({ projectId, pinId });
      } catch {
        setMessage(FAILED);
      }
    },
    discuss: async (pin, title) => {
      setMessage(null);
      if (threadId !== null) {
        if (pin.threadIds.includes(threadId)) return;
        try {
          const result = await linkPinThread.mutate({
            projectId,
            pinId: pin.id,
            threadId,
          });
          if (!result.ok) setMessage(reasonMessage(result.reason));
        } catch {
          setMessage(FAILED);
        }
        return;
      }
      const lines = [
        `Discuss a design wiki pin on page ${pin.pageId}${title === null ? "" : ` (${title})`}.`,
        pin.claim === null ? null : `Claim: ${pin.claim.label}`,
        `Pin note: ${pin.body}`,
      ].filter((line): line is string => line !== null);
      navigate.toCompose({ projectId, initialPrompt: lines.join("\n") });
      setMessage(
        "Discussion draft opened. It is not linked to this pin, because no thread exists yet.",
      );
    },
  };
}

function anchorLabel(pin: Pin): string {
  const anchor = pin.anchor;
  if (anchor.state === "page") return "Page";
  if (anchor.state === "claim") return `Claim, line ${anchor.line}`;
  if (anchor.state === "detached") {
    if (anchor.reason === "page-missing") return "Detached, page gone";
    if (anchor.reason === "ambiguous") return "Detached, claim now ambiguous";
    return "Detached, claim changed";
  }
  return "Unverified";
}

const ANCHOR_TONE: Record<Pin["anchor"]["state"], string> = {
  page: "border-border text-subtle-foreground",
  claim: "border-success/30 bg-success/10 text-success",
  detached: "border-destructive/30 bg-destructive/10 text-destructive-text",
  unverified: "border-warning/30 bg-warning/10 text-warning-text",
};

export function PinRow(props: {
  pin: Pin;
  actions: PinActions;
  pageTitle: string | null;
  showPage?: boolean;
}) {
  const { pin, actions } = props;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(pin.body);
  const resolved = pin.resolvedAt !== null;
  const hereLinked =
    actions.threadId !== null && pin.threadIds.includes(actions.threadId);
  const otherThreads = pin.threadIds.filter((id) => id !== actions.threadId);

  return (
    <li
      data-pin-id={pin.id}
      className={cn(
        "flex flex-col gap-1.5 rounded-md border border-border p-2",
        resolved ? "opacity-70" : null,
      )}
    >
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span
          data-pin-anchor={pin.anchor.state}
          className={cn(
            "inline-flex rounded-full border px-2 py-0.5 font-medium leading-none",
            ANCHOR_TONE[pin.anchor.state],
          )}
        >
          {anchorLabel(pin)}
        </span>
        {resolved ? (
          <span className="text-subtle-foreground">Resolved</span>
        ) : null}
        {props.showPage === true ? (
          <span className="font-mono text-subtle-foreground">{pin.pageId}</span>
        ) : null}
        {pin.claim === null ? null : (
          <span className="min-w-0 break-words text-subtle-foreground">
            {pin.claim.label}
          </span>
        )}
      </div>
      {editing ? (
        <div className="flex flex-col gap-1.5">
          <textarea
            aria-label="Pin note"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            rows={3}
            className="w-full rounded-md border border-border bg-background p-2 text-sm"
          />
          <div className="flex gap-2">
            <button
              type="button"
              className={BUTTON}
              disabled={draft.trim() === ""}
              onClick={async () => {
                if (await actions.update({ pinId: pin.id, body: draft })) {
                  setEditing(false);
                }
              }}
            >
              Save
            </button>
            <button
              type="button"
              className={BUTTON}
              onClick={() => {
                setDraft(pin.body);
                setEditing(false);
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <p className="whitespace-pre-wrap break-words text-sm">{pin.body}</p>
      )}
      {hereLinked ? (
        <p className="text-xs text-subtle-foreground">
          Discussed in this thread
        </p>
      ) : null}
      {otherThreads.length === 0 ? null : (
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <span className="text-subtle-foreground">Threads</span>
          {otherThreads.map((id) => (
            <button
              key={id}
              type="button"
              className={BUTTON}
              onClick={() => actions.openThread(id)}
            >
              Open {id}
            </button>
          ))}
        </div>
      )}
      <PinDecisions pinId={pin.id} actions={actions} />
      <PinCards pinId={pin.id} actions={actions} />
      {editing ? null : (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className={BUTTON}
            onClick={() =>
              void actions.update({ pinId: pin.id, resolved: !resolved })
            }
          >
            {resolved ? "Reopen" : "Resolve"}
          </button>
          <button
            type="button"
            className={BUTTON}
            onClick={() => {
              setDraft(pin.body);
              setEditing(true);
            }}
          >
            Edit
          </button>
          {hereLinked ? null : (
            <button
              type="button"
              className={BUTTON}
              onClick={() => void actions.discuss(pin, props.pageTitle)}
            >
              Discuss now
            </button>
          )}
          <button
            type="button"
            className={BUTTON}
            onClick={() => void actions.remove(pin.id)}
          >
            Delete
          </button>
        </div>
      )}
    </li>
  );
}

function ClaimPinButton(props: {
  index: number;
  label: string;
  count: number;
  menu?: boolean;
  onPin: (index: number) => void;
}) {
  const marker = props.menu
    ? { "data-pin-menu-claim-index": props.index }
    : { "data-pin-claim-index": props.index };
  return (
    <button
      type="button"
      {...marker}
      aria-label={`Pin claim: ${props.label}`}
      onClick={() => props.onPin(props.index)}
      className="ml-1 inline-flex min-w-5 items-center justify-center rounded-full border border-border px-1.5 text-xs leading-5 text-subtle-foreground hover:bg-muted"
    >
      <span aria-hidden>{props.menu ? props.label : props.count || "+"}</span>
    </button>
  );
}

function ClaimMenu(props: {
  indices: number[];
  page: WikiPage;
  counts: Map<number, number>;
  onPin: (index: number) => void;
}) {
  if (props.indices.length === 0) return null;
  return (
    <details className="my-3 rounded-md border border-border p-2 text-xs">
      <summary className="cursor-pointer text-subtle-foreground">
        {`Claims without an inline control (${props.indices.length})`}
      </summary>
      <ul className="mt-2 flex flex-col gap-1">
        {props.indices.map((index) => (
          <li key={index} className="flex items-center gap-2">
            <ClaimPinButton
              menu
              index={index}
              label={props.page.claims[index]?.label ?? ""}
              count={props.counts.get(index) ?? 0}
              onPin={props.onPin}
            />
            {(props.counts.get(index) ?? 0) > 0 ? (
              <span className="text-subtle-foreground">
                {props.counts.get(index)} pinned
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </details>
  );
}

interface Composing {
  pageId: string;
  claim: ClaimTarget | null;
  label: string | null;
}

function Composer(props: {
  targetLabel: string;
  canDiscuss: boolean;
  busy: boolean;
  onKeep: (body: string) => void;
  onDiscuss: (body: string) => void;
  onCancel: () => void;
}) {
  const [body, setBody] = useState("");
  const empty = body.trim() === "";
  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-border p-2">
      <p className="text-xs text-subtle-foreground">{props.targetLabel}</p>
      <textarea
        aria-label="Pin note"
        value={body}
        onChange={(event) => setBody(event.target.value)}
        rows={3}
        className="w-full rounded-md border border-border bg-background p-2 text-sm"
      />
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className={BUTTON}
          disabled={empty || props.busy}
          onClick={() => props.onKeep(body.trim())}
        >
          Keep as note
        </button>
        <button
          type="button"
          className={BUTTON}
          disabled={empty || props.busy}
          onClick={() => props.onDiscuss(body.trim())}
        >
          Discuss now
        </button>
        <button type="button" className={BUTTON} onClick={props.onCancel}>
          Cancel
        </button>
      </div>
      {props.canDiscuss ? null : (
        <p className="text-xs text-subtle-foreground">
          Discuss now opens a new draft; it is not linked to the pin.
        </p>
      )}
    </div>
  );
}

export function PinnedPage(props: {
  projectId: string;
  page: WikiPage;
  threadId: string | null;
  onOpenCard?: (key: string) => void;
}) {
  const { projectId, page, threadId } = props;
  const actions = usePinActions(projectId, threadId);
  const query = useRpcQuery({
    contract: designWikiRpcContract,
    method: "pins",
    input: { projectId },
  });
  const [draft, setComposing] = useState<Composing | null>(null);
  const [busy, setBusy] = useState(false);

  const sites = useMemo(() => extractClaimSites(page.body), [page.body]);
  const targets = useMemo(
    () => page.claims.map((_claim, index) => claimTargetAt(page, index)),
    [page],
  );
  const byKey = useMemo(() => {
    const result = new Map<string, number>();
    targets.forEach((target, index) => {
      if (target !== null) result.set(claimKey(target), index);
    });
    return result;
  }, [targets]);
  const pins = useMemo(
    () =>
      (query.data ?? [])
        .filter((pin) => pin.pageId === page.id)
        .map((pin): Pin =>
          pin.claim !== null &&
          pin.anchor.state === "claim" &&
          !byKey.has(claimKey(pin.claim))
            ? {
                ...pin,
                anchor: { state: "detached", reason: "claim-changed" },
              }
            : pin,
        ),
    [query.data, page.id, byKey],
  );
  const counts = useMemo(() => {
    const result = new Map<number, number>();
    for (const pin of pins) {
      if (pin.claim === null || pin.anchor.state !== "claim") continue;
      const index = byKey.get(claimKey(pin.claim));
      if (index !== undefined) result.set(index, (result.get(index) ?? 0) + 1);
    }
    return result;
  }, [pins, byKey]);

  const composing =
    draft !== null &&
    draft.pageId === page.id &&
    (draft.claim === null || byKey.has(claimKey(draft.claim)))
      ? draft
      : null;

  const open = (claimIndex: number | null) => {
    actions.setMessage(null);
    if (claimIndex === null) {
      setComposing({ pageId: page.id, claim: null, label: null });
      return;
    }
    const claim = targets[claimIndex];
    if (claim === null || claim === undefined) {
      actions.setMessage(REASON_MESSAGE["unknown-claim"] ?? FAILED);
      return;
    }
    setComposing({
      pageId: page.id,
      claim,
      label: page.claims[claimIndex]?.label ?? null,
    });
  };

  const aligned = sites.length === page.claims.length;
  const layer: ClaimLayer | undefined = aligned
    ? {
        sites,
        control: (index) => (
          <ClaimPinButton
            index={index}
            label={page.claims[index]?.label ?? ""}
            count={counts.get(index) ?? 0}
            onPin={open}
          />
        ),
        menu: (indices) => (
          <ClaimMenu
            indices={indices}
            page={page}
            counts={counts}
            onPin={open}
          />
        ),
      }
    : undefined;

  const submit = async (body: string, discuss: boolean) => {
    if (composing === null) return;
    setBusy(true);
    try {
      const created = await actions.create({
        pageId: composing.pageId,
        claim: composing.claim,
        body,
      });
      if (created === null) return;
      setComposing(null);
      if (discuss) await actions.discuss(created, page.title);
    } finally {
      setBusy(false);
    }
  };

  const pinsSection = (
    <section
      aria-label="Pins"
      className="flex flex-col gap-2 rounded-md border border-border p-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">
          {pins.length === 0 ? "Pins" : `Pins (${pins.length})`}
        </h2>
        <button type="button" className={BUTTON} onClick={() => open(null)}>
          Pin this page
        </button>
      </div>
      {composing === null ? null : (
        <Composer
          key={`${composing.pageId}:${composing.claim === null ? "page" : claimKey(composing.claim)}`}
          targetLabel={
            composing.claim === null
              ? "Pinning this page"
              : `Pinning claim: ${composing.label ?? ""}`
          }
          canDiscuss={threadId !== null}
          busy={busy}
          onKeep={(body) => void submit(body, false)}
          onDiscuss={(body) => void submit(body, true)}
          onCancel={() => setComposing(null)}
        />
      )}
      {actions.message === null ? null : (
        <p role="status" className="text-xs text-subtle-foreground">
          {actions.message}
        </p>
      )}
      {pins.length === 0 ? null : (
        <ul className="flex flex-col gap-2">
          {pins.map((pin) => (
            <PinRow
              key={pin.id}
              pin={pin}
              actions={actions}
              pageTitle={page.title}
            />
          ))}
        </ul>
      )}
      {aligned ? null : (
        <ClaimMenu
          indices={page.claims.map((_claim, index) => index)}
          page={page}
          counts={counts}
          onPin={open}
        />
      )}
    </section>
  );

  return (
    <WikiPageView
      page={page}
      pinsSection={pinsSection}
      {...(layer === undefined ? {} : { claimLayer: layer })}
      {...(props.onOpenCard === undefined
        ? {}
        : { onOpenCard: props.onOpenCard })}
    />
  );
}
