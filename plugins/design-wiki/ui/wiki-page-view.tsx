import { Children, Fragment, isValidElement, type ReactNode } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";
import { classifyClaimText, splitCardRefs } from "../claims.js";
import type { WikiPage } from "../wiki-types.js";
import { STATUS_CELL_TONE, StatusPill, STATUS_TONE } from "./status.js";

export const CARD_HREF_PREFIX = "/plugins/tasks/tasks/task/";

export interface WikiPageViewProps {
  page: WikiPage;
  onOpenCard?: (key: string) => void;
  className?: string;
}

function plainText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(plainText).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) {
    return plainText(node.props.children);
  }
  return "";
}

export function CardLink(props: {
  cardKey: string;
  onOpenCard?: (key: string) => void;
  children?: ReactNode;
}) {
  const { cardKey, onOpenCard } = props;
  return (
    <a
      href={`${CARD_HREF_PREFIX}${encodeURIComponent(cardKey)}`}
      data-wiki-card={cardKey}
      className="rounded-sm font-medium text-accent-foreground underline decoration-dotted underline-offset-2 hover:decoration-solid"
      onClick={
        onOpenCard === undefined
          ? undefined
          : (event) => {
              event.preventDefault();
              onOpenCard(cardKey);
            }
      }
    >
      {props.children ?? cardKey}
    </a>
  );
}

function linkifyCards(
  children: ReactNode,
  onOpenCard: ((key: string) => void) | undefined,
): ReactNode {
  return Children.map(children, (child, index) => {
    if (typeof child !== "string") return child;
    return (
      <Fragment key={index}>
        {splitCardRefs(child).map((segment, segmentIndex) =>
          segment.kind === "card" ? (
            <CardLink
              key={segmentIndex}
              cardKey={segment.key}
              {...(onOpenCard === undefined ? {} : { onOpenCard })}
            >
              {segment.text}
            </CardLink>
          ) : (
            <Fragment key={segmentIndex}>{segment.text}</Fragment>
          ),
        )}
      </Fragment>
    );
  });
}

function wikiComponents(
  onOpenCard: ((key: string) => void) | undefined,
): Components {
  const linked = (children: ReactNode) => linkifyCards(children, onOpenCard);
  return {
    p: ({ children }) => <p>{linked(children)}</p>,
    li: ({ children }) => <li>{linked(children)}</li>,
    em: ({ children }) => <em>{linked(children)}</em>,
    th: ({ children }) => <th>{linked(children)}</th>,
    strong: ({ children }) => {
      const claim = classifyClaimText(plainText(children));
      if (claim === null) return <strong>{linked(children)}</strong>;
      return (
        <strong
          data-wiki-claim={claim.status}
          className={cn(
            "rounded-sm border px-1.5 py-px font-semibold",
            STATUS_TONE[claim.status],
          )}
        >
          {linked(children)}
        </strong>
      );
    },
    td: ({ children }) => {
      const claim = classifyClaimText(plainText(children));
      if (claim === null) return <td>{linked(children)}</td>;
      return (
        <td
          data-wiki-claim={claim.status}
          className={STATUS_CELL_TONE[claim.status]}
        >
          {linked(children)}
        </td>
      );
    },
    a: ({ href, children }) => (
      <a
        href={href}
        rel="noreferrer noopener"
        target="_blank"
        className="text-accent-foreground underline underline-offset-2"
      >
        {children}
      </a>
    ),
  };
}

const PROSE_CLASSES = [
  "text-sm leading-relaxed text-foreground",
  "[&_h1]:mb-3 [&_h1]:text-lg [&_h1]:font-semibold",
  "[&_h2]:mb-2 [&_h2]:mt-6 [&_h2]:text-base [&_h2]:font-semibold",
  "[&_h3]:mb-2 [&_h3]:mt-4 [&_h3]:text-sm [&_h3]:font-semibold",
  "[&_p]:my-2 [&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-1",
  "[&_code]:rounded-sm [&_code]:bg-muted [&_code]:px-1 [&_code]:py-px [&_code]:text-xs",
  "[&_pre]:my-3 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-muted [&_pre]:p-3 [&_pre_code]:bg-transparent [&_pre_code]:p-0",
  "[&_blockquote]:my-3 [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground",
  "[&_table]:my-3 [&_table]:w-full [&_table]:border-collapse [&_th]:border [&_th]:border-border [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_th]:font-medium [&_td]:border [&_td]:border-border [&_td]:px-2 [&_td]:py-1 [&_td]:align-top",
].join(" ");

export function WikiPageBody(props: {
  body: string;
  onOpenCard?: (key: string) => void;
  className?: string;
}) {
  return (
    <div data-wiki-body className={cn(PROSE_CLASSES, props.className)}>
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={wikiComponents(props.onOpenCard)}
      >
        {props.body}
      </Markdown>
    </div>
  );
}

export function WikiPageView(props: WikiPageViewProps) {
  const { page, onOpenCard } = props;
  return (
    <article
      data-wiki-page={page.id}
      className={cn("flex min-w-0 flex-col gap-4", props.className)}
    >
      <header
        aria-label={`${page.title} details`}
        className="flex flex-col gap-2 border-b border-border pb-3"
      >
        <div className="flex flex-wrap items-center gap-2">
          <StatusPill status={page.status} />
          {page.card === null ? null : (
            <CardLink
              cardKey={page.card}
              {...(onOpenCard === undefined ? {} : { onOpenCard })}
            />
          )}
        </div>
        <dl className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-subtle-foreground">
          <div className="flex gap-1">
            <dt>id</dt>
            <dd className="font-mono text-foreground">{page.id}</dd>
          </div>
          <div className="flex gap-1">
            <dt>updated</dt>
            <dd className="text-foreground">{page.updated}</dd>
          </div>
          <div className="flex min-w-0 gap-1">
            <dt>source</dt>
            <dd className="min-w-0 break-words text-foreground">
              {page.source}
            </dd>
          </div>
        </dl>
      </header>
      <WikiPageBody
        body={page.body}
        {...(onOpenCard === undefined ? {} : { onOpenCard })}
      />
    </article>
  );
}
