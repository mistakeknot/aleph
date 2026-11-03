import {
  Children,
  createContext,
  Fragment,
  isValidElement,
  type ReactNode,
  useContext,
  useMemo,
} from "react";
import Markdown, { type Components, type ExtraProps } from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";
import { type ClaimSite, classifyClaimText, splitCardRefs } from "../claims.js";
import type { WikiPage } from "../wiki-types.js";
import {
  CLAIM_MENU_TAG,
  claimIndexOf,
  createClaimMapper,
  type HastNode,
  unmappedOf,
} from "./claim-sites.js";
import { STATUS_CELL_TONE, StatusPill, STATUS_TONE } from "./status.js";

export const CARD_HREF_PREFIX = "/plugins/tasks/tasks/task/";

export interface ClaimLayer {
  sites: ClaimSite[];
  control: (claimIndex: number) => ReactNode;
  menu: (claimIndices: number[]) => ReactNode;
}

export interface WikiPageViewProps {
  page: WikiPage;
  onOpenCard?: (key: string) => void;
  className?: string;
  claimLayer?: ClaimLayer;
  pinsSection?: ReactNode;
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

const ClaimLayerContext = createContext<ClaimLayer | null>(null);

type Linked = (children: ReactNode) => ReactNode;

function ClaimControl(props: { node: HastNode | undefined }) {
  const layer = useContext(ClaimLayerContext);
  const index = claimIndexOf(props.node);
  if (layer === null || index === null) return null;
  return <>{layer.control(index)}</>;
}

function WikiStrong(props: {
  children?: ReactNode;
  node: HastNode | undefined;
  linked: Linked;
}) {
  const claim = classifyClaimText(plainText(props.children));
  const control = <ClaimControl node={props.node} />;
  if (claim === null) {
    return (
      <>
        <strong>{props.linked(props.children)}</strong>
        {control}
      </>
    );
  }
  return (
    <>
      <strong
        data-wiki-claim={claim.status}
        className={cn(
          "rounded-sm border px-1.5 py-px font-semibold",
          STATUS_TONE[claim.status],
        )}
      >
        {props.linked(props.children)}
      </strong>
      {control}
    </>
  );
}

function WikiCell(props: {
  tag: "td" | "th";
  children?: ReactNode;
  node: HastNode | undefined;
  linked: Linked;
}) {
  const Tag = props.tag;
  const claim =
    props.tag === "td" ? classifyClaimText(plainText(props.children)) : null;
  const control = <ClaimControl node={props.node} />;
  if (claim === null) {
    return (
      <Tag>
        {props.linked(props.children)}
        {control}
      </Tag>
    );
  }
  return (
    <Tag
      data-wiki-claim={claim.status}
      className={STATUS_CELL_TONE[claim.status]}
    >
      {props.linked(props.children)}
      {control}
    </Tag>
  );
}

function WikiClaimMenu(props: { node: HastNode | undefined }) {
  const layer = useContext(ClaimLayerContext);
  if (layer === null) return null;
  const indices = unmappedOf(props.node);
  if (indices.length === 0) return null;
  return <>{layer.menu(indices)}</>;
}

function wikiComponents(
  onOpenCard: ((key: string) => void) | undefined,
): Components {
  const linked: Linked = (children) => linkifyCards(children, onOpenCard);
  const base: Components = {
    p: ({ children }) => <p>{linked(children)}</p>,
    li: ({ children }) => <li>{linked(children)}</li>,
    em: ({ children }) => <em>{linked(children)}</em>,
    th: ({ children, node }) => (
      <WikiCell tag="th" node={node} linked={linked}>
        {children}
      </WikiCell>
    ),
    strong: ({ children, node }) => (
      <WikiStrong node={node} linked={linked}>
        {children}
      </WikiStrong>
    ),
    td: ({ children, node }) => (
      <WikiCell tag="td" node={node} linked={linked}>
        {children}
      </WikiCell>
    ),
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
  const menu = {
    [CLAIM_MENU_TAG]: ({ node }: ExtraProps) => <WikiClaimMenu node={node} />,
  };
  return { ...base, ...menu } as Components;
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
  const layer = useContext(ClaimLayerContext);
  const sites = layer?.sites;
  const components = useMemo(
    () => wikiComponents(props.onOpenCard),
    [props.onOpenCard],
  );
  const rehypePlugins = useMemo(
    () => (sites === undefined ? [] : [createClaimMapper(sites)]),
    [sites],
  );
  return (
    <div data-wiki-body className={cn(PROSE_CLASSES, props.className)}>
      <Markdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={rehypePlugins}
        components={components}
      >
        {props.body}
      </Markdown>
    </div>
  );
}

export function WikiPageView(props: WikiPageViewProps) {
  const { page, onOpenCard, claimLayer, pinsSection } = props;
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
      {pinsSection}
      <ClaimLayerContext.Provider value={claimLayer ?? null}>
        <WikiPageBody
          body={page.body}
          {...(onOpenCard === undefined ? {} : { onOpenCard })}
        />
      </ClaimLayerContext.Provider>
    </article>
  );
}
