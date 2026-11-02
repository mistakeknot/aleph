import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ArgTypes, Story, StoryDefault } from "@ladle/react";
import { FakePaneContent } from "./FakePaneContent";
import {
  StackedPaneStrip,
  type FocusAlign,
  type SnapMode,
  type StripMetrics,
} from "./StackedPaneStrip";
import {
  POOL_SIZE,
  appendPane,
  closePane,
  makeFakePane,
  makeInitialStack,
  paneIdForIndex,
  pushFromPane,
  type FakePane,
  type LinkBehavior,
  type LinkModifier,
} from "./model";

export default {
  title: "aleph/Stacked panes prototype",
} satisfies StoryDefault;

type ViewportPreset = "1512" | "1800" | "3840" | "window";
type AgentPush = "pulse" | "scroll";

interface PrototypeArgs {
  viewport: ViewportPreset;
  fitToBrowser: boolean;
  sidebarOpen: boolean;
  sidebarWidth: number;
  paneCount: number;
  paneWidth: number;
  spineWidth: number;
  snap: SnapMode;
  gutter: boolean;
  trailingSpace: boolean;
  align: FocusAlign;
  linkBehavior: LinkBehavior;
  agentPush: AgentPush;
  spineStatus: boolean;
  spineUnread: boolean;
  spineStripe: boolean;
}

const BASE_ARGS: PrototypeArgs = {
  viewport: "1512",
  fitToBrowser: true,
  sidebarOpen: true,
  sidebarWidth: 322,
  paneCount: 6,
  paneWidth: 680,
  spineWidth: 40,
  snap: "proximity",
  gutter: false,
  trailingSpace: true,
  align: "reveal",
  linkBehavior: "truncate",
  agentPush: "pulse",
  spineStatus: true,
  spineUnread: true,
  spineStripe: true,
};

const ARG_TYPES: ArgTypes<PrototypeArgs> = {
  viewport: {
    control: { type: "radio" },
    options: ["1512", "1800", "3840", "window"],
    description:
      "Simulated window width in CSS px: 1512 MacBook Pro 14 default, 1800 More Space, 3840 Dell 38 inch, or the real Ladle window.",
  },
  fitToBrowser: {
    control: { type: "boolean" },
    description:
      "Scale the simulated window down to fit this browser tab. Off shows it at 1:1 inside a scrolling frame.",
  },
  sidebarOpen: { control: { type: "boolean" } },
  sidebarWidth: { control: { type: "range", min: 200, max: 400, step: 2 } },
  paneCount: { control: { type: "range", min: 1, max: 12, step: 1 } },
  paneWidth: {
    control: { type: "range", min: 360, max: 1000, step: 10 },
    description: "W in CSS px. The design note clamps this to 560-900.",
  },
  spineWidth: {
    control: { type: "range", min: 24, max: 72, step: 2 },
    description: "S in CSS px. The design note proposes 40.",
  },
  snap: {
    control: { type: "radio" },
    options: ["proximity", "mandatory", "off"],
    description: "CSS scroll-snap-type on the strip.",
  },
  gutter: {
    control: { type: "boolean" },
    description:
      "On: every pane reserves a spine-width gutter and always shows its spine. Off: the spine only appears over a covered pane.",
  },
  trailingSpace: {
    control: { type: "boolean" },
    description:
      "Extend the scroll area so the last pane can reach its own slot. Off: the last pane ends flush right.",
  },
  align: {
    control: { type: "radio" },
    options: ["reveal", "slot"],
    description:
      "How focusing a pane scrolls. reveal: scroll only as far as needed, so a wide window keeps many panes fully open. slot: Matuschak style, the focused pane takes its slot and every earlier pane collapses to a spine.",
  },
  linkBehavior: {
    control: { type: "radio" },
    options: ["truncate", "append"],
    description:
      "Plain click on a link in pane i: close everything right of i (Matuschak) or append at the end. Cmd/Ctrl-click does the other; Alt-click replaces.",
  },
  agentPush: {
    control: { type: "radio" },
    options: ["pulse", "scroll"],
    description:
      "bb thread open from an agent: light up the spine without moving focus, or scroll to the new pane and focus it.",
  },
  spineStatus: { control: { type: "boolean" } },
  spineUnread: { control: { type: "boolean" } },
  spineStripe: { control: { type: "boolean" } },
};

const VIEWPORT_SIZE: Record<
  Exclude<ViewportPreset, "window">,
  { width: number; height: number }
> = {
  "1512": { width: 1512, height: 982 },
  "1800": { width: 1800, height: 1169 },
  "3840": { width: 3840, height: 1600 },
};

function useElementWidth() {
  const ref = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    setWidth(element.clientWidth);
    const observer = new ResizeObserver(() => setWidth(element.clientWidth));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return { ref, width };
}

function ToolbarButton({
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="cursor-pointer rounded-md border border-border bg-background px-2.5 py-1 text-sm text-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
    >
      {label}
    </button>
  );
}

function Prototype(args: PrototypeArgs) {
  const {
    viewport,
    fitToBrowser,
    sidebarOpen,
    sidebarWidth,
    paneCount,
    paneWidth,
    spineWidth,
    snap,
    gutter,
    trailingSpace,
    align,
    linkBehavior,
    agentPush,
    spineStatus,
    spineUnread,
    spineStripe,
  } = args;
  const [panes, setPanes] = useState<FakePane[]>(() =>
    makeInitialStack(paneCount),
  );
  const [focusedId, setFocusedId] = useState<string>(
    () => makeInitialStack(paneCount).at(-1)?.id ?? "",
  );
  const [pulseIds, setPulseIds] = useState<ReadonlySet<string>>(new Set());
  const [metrics, setMetrics] = useState<StripMetrics | null>(null);
  const { ref: hostRef, width: hostWidth } = useElementWidth();

  const resetStack = useCallback((count: number) => {
    const next = makeInitialStack(count);
    setPanes(next);
    setFocusedId(next.at(-1)?.id ?? "");
    setPulseIds(new Set());
  }, []);

  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    resetStack(paneCount);
  }, [paneCount, resetStack]);

  const size =
    viewport === "window"
      ? { width: Math.max(hostWidth, 640), height: 760 }
      : VIEWPORT_SIZE[viewport];
  const scale =
    fitToBrowser && hostWidth > 0 ? Math.min(1, hostWidth / size.width) : 1;

  const titleOf = useCallback((paneId: string) => makeFakePane(paneId).title, []);

  const focusPane = useCallback((paneId: string) => {
    setFocusedId(paneId);
    setPulseIds((current) => {
      if (!current.has(paneId)) return current;
      const next = new Set(current);
      next.delete(paneId);
      return next;
    });
  }, []);

  const closeOne = useCallback(
    (paneId: string) => {
      const result = closePane(panes, paneId, focusedId);
      setPanes(result.panes);
      setFocusedId(result.focusedId);
    },
    [panes, focusedId],
  );

  const openLink = useCallback(
    (sourceId: string, targetId: string, modifier: LinkModifier) => {
      const result = pushFromPane(
        panes,
        sourceId,
        targetId,
        linkBehavior,
        modifier,
      );
      setPanes(result.panes);
      focusPane(result.focusedId);
    },
    [panes, linkBehavior, focusPane],
  );

  const nextUnusedId = useCallback(() => {
    for (let index = 0; index < POOL_SIZE; index += 1) {
      const id = paneIdForIndex(index);
      if (!panes.some((pane) => pane.id === id)) return id;
    }
    return null;
  }, [panes]);

  const openFromSidebar = useCallback(
    (paneId: string) => {
      const result = appendPane(panes, paneId);
      setPanes(result.panes);
      focusPane(result.focusedId);
    },
    [panes, focusPane],
  );

  const agentOpen = useCallback(() => {
    const id = nextUnusedId();
    if (!id) return;
    const result = appendPane(panes, id);
    setPanes(result.panes);
    if (agentPush === "scroll") {
      focusPane(result.focusedId);
    } else {
      setPulseIds((current) => new Set(current).add(id));
    }
  }, [agentPush, panes, nextUnusedId, focusPane]);

  const closeRight = useCallback(() => {
    const index = panes.findIndex((pane) => pane.id === focusedId);
    if (index < 0) return;
    setPanes(panes.slice(0, index + 1));
  }, [panes, focusedId]);

  const spineDisplay = useMemo(
    () => ({ status: spineStatus, unread: spineUnread, stripe: spineStripe }),
    [spineStatus, spineUnread, spineStripe],
  );

  const strip = (
    <StackedPaneStrip
      panes={panes}
      focusedId={focusedId}
      paneWidth={paneWidth}
      spineWidth={spineWidth}
      snap={snap}
      gutter={gutter}
      trailingSpace={trailingSpace}
      align={align}
      spineDisplay={spineDisplay}
      pulseIds={pulseIds}
      onFocus={focusPane}
      onClose={closeOne}
      onMetrics={setMetrics}
      renderPane={(pane, context) => (
        <FakePaneContent
          pane={pane}
          width={context.width}
          titleOf={titleOf}
          onOpenLink={(targetId, modifier) =>
            openLink(pane.id, targetId, modifier)
          }
        />
      )}
    />
  );

  return (
    <div className="flex min-h-screen flex-col gap-3 bg-sidebar p-4 text-foreground">
      <div className="flex flex-wrap items-center gap-2">
        <ToolbarButton label="Reset stack" onClick={() => resetStack(paneCount)} />
        <ToolbarButton label="Open from sidebar (append)" onClick={() => {
          const id = nextUnusedId();
          if (id) openFromSidebar(id);
        }} />
        <ToolbarButton label="Agent: bb thread open" onClick={agentOpen} />
        <ToolbarButton label="Close right of focused" onClick={closeRight} />
        <span className="text-sm text-muted-foreground">
          Link click: {linkBehavior === "truncate" ? "truncates right" : "appends"}
          ; Cmd/Ctrl-click does the other; Alt-click replaces. Alt+Left/Right
          focus, Alt+W close, Alt+1..9 jump.
        </span>
      </div>
      <div
        className="text-sm text-muted-foreground"
        role="status"
        aria-live="off"
      >
        Window {size.width}×{size.height} at {Math.round(scale * 100)}% · strip{" "}
        {metrics?.contentWidth ?? "-"} px · {panes.length} panes · full panes{" "}
        {metrics?.fullPanes ?? "-"} · spines left {metrics?.leftSpines ?? "-"} /
        right {metrics?.rightSpines ?? "-"} · scrollLeft{" "}
        {metrics?.scrollLeft ?? "-"}
        {paneWidth < 560 || paneWidth > 900
          ? " · W is outside the note's 560-900 clamp"
          : ""}
      </div>
      <div ref={hostRef} className="w-full">
        <div
          className="overflow-hidden rounded-lg border border-border shadow-lg"
          style={{ width: size.width * scale, height: size.height * scale }}
        >
          <div
            className="flex bg-background"
            style={{
              width: size.width,
              height: size.height,
              transform: `scale(${scale})`,
              transformOrigin: "top left",
            }}
          >
            {sidebarOpen ? (
              <nav
                aria-label="Fake sidebar"
                className="flex shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-border bg-sidebar p-2"
                style={{ width: sidebarWidth }}
              >
                {Array.from({ length: POOL_SIZE }, (_, index) => {
                  const pane = makeFakePane(paneIdForIndex(index));
                  const open = panes.some((entry) => entry.id === pane.id);
                  return (
                    <button
                      key={pane.id}
                      type="button"
                      onClick={() => openFromSidebar(pane.id)}
                      className={`cursor-pointer truncate rounded px-2 py-1.5 text-left text-sm hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ${
                        open ? "text-foreground" : "text-muted-foreground"
                      }`}
                    >
                      {pane.title}
                    </button>
                  );
                })}
              </nav>
            ) : null}
            {strip}
          </div>
        </div>
      </div>
    </div>
  );
}

function makeStory(overrides: Partial<PrototypeArgs>): Story<PrototypeArgs> {
  const story: Story<PrototypeArgs> = (args) => <Prototype {...args} />;
  story.args = { ...BASE_ARGS, ...overrides };
  story.argTypes = ARG_TYPES;
  return story;
}

export const Laptop1512 = makeStory({ viewport: "1512", paneCount: 6 });
Laptop1512.storyName = "Laptop 1512";

export const Laptop1800 = makeStory({ viewport: "1800", paneCount: 6 });
Laptop1800.storyName = "Laptop 1800";

export const Ultrawide3840 = makeStory({
  viewport: "3840",
  paneCount: 8,
  paneWidth: 680,
});
Ultrawide3840.storyName = "Ultrawide 3840 W680";

export const Ultrawide3840Wide = makeStory({
  viewport: "3840",
  paneCount: 8,
  paneWidth: 860,
});
Ultrawide3840Wide.storyName = "Ultrawide 3840 W860";

export const RealWindow = makeStory({ viewport: "window", paneCount: 6 });
RealWindow.storyName = "Real window";
