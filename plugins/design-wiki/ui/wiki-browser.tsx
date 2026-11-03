import { experimental_useRpcQuery as useRpcQuery } from "@get-bb/plugin-sdk/app";
import { designWikiRpcContract } from "../contract.js";
import { WikiListView } from "./wiki-list-view.js";
import { PinnedPage, PinRow, usePinActions } from "./pinned-page.js";

import { openCard } from "./open-card.js";

export { openCard };

export function Message(props: { children: string; tone?: "error" }) {
  return (
    <p
      role={props.tone === "error" ? "alert" : "status"}
      className={
        props.tone === "error"
          ? "text-sm text-destructive-text"
          : "text-sm text-subtle-foreground"
      }
    >
      {props.children}
    </p>
  );
}

function DetachedPins(props: {
  projectId: string;
  threadId: string | null;
  pageIds: Set<string>;
}) {
  const query = useRpcQuery({
    contract: designWikiRpcContract,
    method: "pins",
    input: { projectId: props.projectId },
  });
  const actions = usePinActions(props.projectId, props.threadId);
  const orphans = (query.data ?? []).filter(
    (pin) => !props.pageIds.has(pin.pageId),
  );
  if (orphans.length === 0) return null;
  return (
    <section
      aria-label="Detached pins"
      className="flex flex-col gap-2 rounded-md border border-border p-3"
    >
      <h2 className="text-sm font-semibold">Detached pins</h2>
      <ul className="flex flex-col gap-2">
        {orphans.map((pin) => (
          <PinRow
            key={pin.id}
            pin={pin}
            actions={actions}
            pageTitle={null}
            showPage
          />
        ))}
      </ul>
      {actions.message === null ? null : (
        <p role="status" className="text-xs text-subtle-foreground">
          {actions.message}
        </p>
      )}
    </section>
  );
}

function PageDetail(props: {
  projectId: string;
  pageId: string;
  threadId: string | null;
}) {
  const query = useRpcQuery({
    contract: designWikiRpcContract,
    method: "page",
    input: { projectId: props.projectId, pageId: props.pageId },
  });
  if (query.error !== null && query.data === undefined) {
    return <Message tone="error">Could not load this page.</Message>;
  }
  if (query.data === undefined) return <Message>Loading page…</Message>;
  if (query.data.state === "missing") {
    return <Message>That page no longer exists.</Message>;
  }
  return (
    <PinnedPage
      key={query.data.page.id}
      projectId={props.projectId}
      page={query.data.page}
      threadId={props.threadId}
      onOpenCard={openCard}
    />
  );
}

export interface WikiBrowserProps {
  projectId: string;
  pageId: string | null;
  onSelectPage: (pageId: string | null) => void;
  layout: "split" | "stacked";
  threadId: string | null;
}

export function WikiBrowser(props: WikiBrowserProps) {
  const { projectId, pageId, onSelectPage, layout, threadId } = props;
  const list = useRpcQuery({
    contract: designWikiRpcContract,
    method: "list",
    input: { projectId },
  });

  if (list.error !== null && list.data === undefined) {
    return <Message tone="error">Could not load the design wiki.</Message>;
  }
  if (list.data === undefined) return <Message>Loading wiki…</Message>;

  if (layout === "stacked" && pageId !== null) {
    return (
      <div className="flex min-h-0 flex-col gap-4">
        <button
          type="button"
          onClick={() => onSelectPage(null)}
          className="self-start rounded-md text-xs font-medium text-subtle-foreground hover:text-foreground"
        >
          Back to pages
        </button>
        <PageDetail projectId={projectId} pageId={pageId} threadId={threadId} />
      </div>
    );
  }

  const known =
    list.data.state === "unavailable"
      ? null
      : new Set(list.data.pages.map((page) => page.id));
  const listView = (
    <div className="flex min-w-0 flex-col gap-4">
      <WikiListView
        list={list.data}
        selectedId={pageId}
        onSelect={(page) => onSelectPage(page.id)}
        onOpenCard={openCard}
      />
      {known === null ? null : (
        <DetachedPins
          projectId={projectId}
          threadId={threadId}
          pageIds={known}
        />
      )}
    </div>
  );
  if (layout === "stacked") return listView;
  return (
    <div className="grid min-h-0 gap-6 lg:grid-cols-[minmax(18rem,26rem)_minmax(0,1fr)]">
      {listView}
      {pageId === null ? null : (
        <PageDetail projectId={projectId} pageId={pageId} threadId={threadId} />
      )}
    </div>
  );
}
