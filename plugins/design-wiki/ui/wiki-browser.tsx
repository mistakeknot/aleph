import { experimental_useRpcQuery as useRpcQuery } from "@get-bb/plugin-sdk/app";
import { designWikiRpcContract } from "../contract.js";
import { WikiListView } from "./wiki-list-view.js";
import { WikiPageView } from "./wiki-page-view.js";

const TASK_PANEL = "/plugins/tasks/tasks/task/";

export function openCard(key: string) {
  window.location.assign(`${TASK_PANEL}${encodeURIComponent(key)}`);
}

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

function PageDetail(props: { projectId: string; pageId: string }) {
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
  return <WikiPageView page={query.data.page} onOpenCard={openCard} />;
}

export interface WikiBrowserProps {
  projectId: string;
  /** The open page, or null while only the list shows. */
  pageId: string | null;
  /** Select a page, or null to go back to the list (stacked layout). */
  onSelectPage: (pageId: string | null) => void;
  /**
   * "split" puts the list and the page side by side (the Wiki page);
   * "stacked" shows one at a time with a back control (the thread panel).
   */
  layout: "split" | "stacked";
}

/**
 * The project's wiki list and page view. The Wiki page and the thread side
 * panel both render this component and differ only in `layout`.
 */
export function WikiBrowser(props: WikiBrowserProps) {
  const { projectId, pageId, onSelectPage, layout } = props;
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
        <PageDetail projectId={projectId} pageId={pageId} />
      </div>
    );
  }

  const listView = (
    <WikiListView
      list={list.data}
      selectedId={pageId}
      onSelect={(page) => onSelectPage(page.id)}
      onOpenCard={openCard}
    />
  );
  if (layout === "stacked") return listView;
  return (
    <div className="grid min-h-0 gap-6 lg:grid-cols-[minmax(18rem,26rem)_minmax(0,1fr)]">
      {listView}
      {pageId === null ? null : (
        <PageDetail projectId={projectId} pageId={pageId} />
      )}
    </div>
  );
}
