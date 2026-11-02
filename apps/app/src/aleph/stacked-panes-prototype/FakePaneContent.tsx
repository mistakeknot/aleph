import type { MouseEvent } from "react";
import { hashString, type FakePane, type LinkModifier } from "./model";

const SENTENCES: readonly string[] = [
  "I traced the layout reflow to the resize handler and the stale cache entry.",
  "The fix keeps the focused pane anchored while the viewport changes.",
  "Running the focused suite now; the first pass is green except one snapshot.",
  "That regression only shows up when the secondary panel is docked on the right.",
  "I would split this into two commits so the review stays small.",
  "The queue drains in order, but the composer draft is restored from the wrong pane.",
  "Checked the daemon log: the reconnect fires twice, one hundred milliseconds apart.",
  "Pane width is the knob that decides how many threads fit on the big monitor.",
  "No change to the persisted shape is needed for this step.",
  "The scroll position is cached per pane and restored on mount.",
];

function sentencesFor(pane: FakePane, count: number): string[] {
  const seed = hashString(pane.id);
  return Array.from(
    { length: count },
    (_, index) => SENTENCES[(seed + index * 7) % SENTENCES.length] ?? "",
  );
}

function modifierFor(event: MouseEvent): LinkModifier {
  if (event.metaKey || event.ctrlKey) return "append";
  if (event.altKey) return "replace";
  return "none";
}

interface LinkPillProps {
  targetId: string;
  label: string;
  onOpen: (targetId: string, modifier: LinkModifier) => void;
}

function LinkPill({ targetId, label, onOpen }: LinkPillProps) {
  return (
    <button
      type="button"
      onClick={(event) => onOpen(targetId, modifierFor(event))}
      className="mx-0.5 cursor-pointer rounded border border-border bg-muted px-1.5 text-sm text-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
    >
      {label}
    </button>
  );
}

export interface FakePaneContentProps {
  pane: FakePane;
  width: number;
  titleOf: (paneId: string) => string;
  onOpenLink: (targetId: string, modifier: LinkModifier) => void;
}

function ThreadBody({ pane, titleOf, onOpenLink }: FakePaneContentProps) {
  const lines = sentencesFor(pane, 16);
  return (
    <>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
        {lines.map((line, index) => {
          const linkTarget =
            index % 5 === 2 ? pane.links[Math.floor(index / 5)] : undefined;
          return (
            <div
              key={index}
              className={
                index % 4 === 0
                  ? "ml-auto max-w-[85%] rounded-lg bg-muted px-3 py-2 text-sm text-foreground"
                  : "text-sm text-foreground"
              }
            >
              {line}
              {linkTarget ? (
                <>
                  {" "}
                  See
                  <LinkPill
                    targetId={linkTarget}
                    label={titleOf(linkTarget)}
                    onOpen={onOpenLink}
                  />
                </>
              ) : null}
            </div>
          );
        })}
      </div>
      <div className="shrink-0 border-t border-border p-3">
        <textarea
          rows={2}
          placeholder={`Message ${pane.title}`}
          className="w-full resize-none rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        />
      </div>
    </>
  );
}

function PluginBody({ pane, titleOf, onOpenLink }: FakePaneContentProps) {
  const cards = Array.from({ length: 9 }, (_, index) => index);
  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-3">
      <p className="mb-3 text-sm text-muted-foreground">
        Fake plugin panel. Cards reflow to the pane width; at 3840 a plugin could
        take a second column instead of a fixed pane.
      </p>
      <div
        className="grid gap-2"
        style={{ gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))" }}
      >
        {cards.map((index) => {
          const target = pane.links[index % pane.links.length];
          return (
            <div
              key={index}
              className="rounded-md border border-border bg-card p-3 text-sm text-foreground"
            >
              <div className="text-muted-foreground">Owed pick {index + 1}</div>
              <div className="mb-2">{sentencesFor(pane, 1)[0]}</div>
              {target ? (
                <LinkPill
                  targetId={target}
                  label={titleOf(target)}
                  onOpen={onOpenLink}
                />
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function FakePaneContent(props: FakePaneContentProps) {
  const { pane, width } = props;
  return (
    <div className="flex h-full flex-col" style={{ width }}>
      <header className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2">
        <span
          aria-hidden
          className="size-2 shrink-0 rounded-full"
          style={{ background: `oklch(0.7 0.14 ${pane.hue})` }}
        />
        <h2 className="min-w-0 flex-1 truncate text-sm text-foreground">
          {pane.title}
        </h2>
        <span className="shrink-0 text-xs text-muted-foreground">
          {pane.kind === "plugin" ? "plugin panel" : pane.status}
        </span>
      </header>
      {pane.kind === "plugin" ? <PluginBody {...props} /> : <ThreadBody {...props} />}
    </div>
  );
}
