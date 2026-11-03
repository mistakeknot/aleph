import { useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import {
  WIKI_KINDS,
  WIKI_STATUSES,
  type WikiKind,
  type WikiList,
  type WikiPageSummary,
  type WikiStatus,
} from "../wiki-types.js";
import { CardLink } from "./wiki-page-view.js";
import { STATUS_LABEL, StatusPill } from "./status.js";

export const KIND_LABEL: Record<WikiKind, string> = {
  cuj: "Critical user journeys",
  requirement: "Requirements",
};

export function filterPages(
  pages: readonly WikiPageSummary[],
  active: ReadonlySet<WikiStatus>,
): WikiPageSummary[] {
  return active.size === 0
    ? [...pages]
    : pages.filter((page) => active.has(page.status));
}

export interface WikiListViewProps {
  list: WikiList;
  selectedId?: string | null;
  onSelect: (page: WikiPageSummary) => void;
  onOpenCard?: (key: string) => void;
}

function StatusChips(props: {
  pages: readonly WikiPageSummary[];
  active: ReadonlySet<WikiStatus>;
  onToggle: (status: WikiStatus) => void;
}) {
  return (
    <div role="group" aria-label="Filter by status" className="flex flex-wrap gap-2">
      {WIKI_STATUSES.map((status) => {
        const count = props.pages.filter((page) => page.status === status).length;
        const pressed = props.active.has(status);
        return (
          <button
            key={status}
            type="button"
            aria-pressed={pressed}
            onClick={() => props.onToggle(status)}
            className={cn(
              "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
              pressed
                ? "border-foreground bg-foreground text-background"
                : "border-border bg-transparent text-subtle-foreground hover:text-foreground",
            )}
          >
            {STATUS_LABEL[status]} <span className="tabular-nums">{count}</span>
          </button>
        );
      })}
    </div>
  );
}

function PageRow(props: {
  page: WikiPageSummary;
  selected: boolean;
  onSelect: (page: WikiPageSummary) => void;
  onOpenCard: ((key: string) => void) | undefined;
}) {
  const { page } = props;
  return (
    <li
      data-wiki-row={page.id}
      className={cn(
        "flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md px-2 py-2",
        props.selected && "bg-muted",
      )}
    >
      <button
        type="button"
        aria-current={props.selected ? "page" : undefined}
        onClick={() => props.onSelect(page)}
        className="min-w-0 flex-1 text-left text-sm font-medium hover:underline"
      >
        {page.title}
      </button>
      <span className="font-mono text-xs text-subtle-foreground">{page.id}</span>
      <StatusPill status={page.status} />
      {page.card === null ? null : (
        <CardLink
          cardKey={page.card}
          {...(props.onOpenCard === undefined
            ? {}
            : { onOpenCard: props.onOpenCard })}
        />
      )}
      <span className="text-xs tabular-nums text-subtle-foreground">
        {page.updated}
      </span>
    </li>
  );
}

export function WikiListView(props: WikiListViewProps) {
  const { list } = props;
  const [active, setActive] = useState<ReadonlySet<WikiStatus>>(new Set());
  const visible = useMemo(
    () => filterPages(list.pages, active),
    [list.pages, active],
  );

  if (list.state === "unavailable") {
    return (
      <p role="status" className="text-sm text-subtle-foreground">
        {list.message ?? "The design wiki is unavailable for this project."}
      </p>
    );
  }
  if (list.state === "empty" && list.errors.length === 0) {
    return (
      <p role="status" className="text-sm text-subtle-foreground">
        {list.message ?? "No design wiki pages in this project yet."}
      </p>
    );
  }

  const toggle = (status: WikiStatus) =>
    setActive((current) => {
      const next = new Set(current);
      if (next.has(status)) next.delete(status);
      else next.add(status);
      return next;
    });

  return (
    <div className="flex flex-col gap-4">
      <StatusChips pages={list.pages} active={active} onToggle={toggle} />
      {WIKI_KINDS.map((kind) => {
        const pages = visible.filter((page) => page.kind === kind);
        const errors = list.errors.filter((error) => error.kind === kind);
        if (pages.length === 0 && errors.length === 0) return null;
        return (
          <section key={kind} aria-label={KIND_LABEL[kind]} className="flex flex-col gap-1">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-subtle-foreground">
              {KIND_LABEL[kind]}
            </h2>
            <ul className="flex flex-col">
              {pages.map((page) => (
                <PageRow
                  key={page.path}
                  page={page}
                  selected={props.selectedId === page.id}
                  onSelect={props.onSelect}
                  onOpenCard={props.onOpenCard}
                />
              ))}
              {errors.map((error) => (
                <li
                  key={error.path}
                  data-wiki-error={error.path}
                  className="rounded-md border border-destructive/30 bg-destructive/5 px-2 py-2 text-sm text-destructive-text"
                >
                  <span className="font-mono text-xs">{error.path}</span>
                  <span className="ml-2">{error.message}</span>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
      {visible.length === 0 && list.pages.length > 0 ? (
        <p role="status" className="text-sm text-subtle-foreground">
          No pages match the selected status.
        </p>
      ) : null}
    </div>
  );
}
