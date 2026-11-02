import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import {
  snapScrollLeft,
  stickyOffsets,
  trailingSpaceWidth,
  type FakePane,
  type FakePaneStatus,
} from "./model";

export type FocusAlign = "slot" | "reveal";

export type SnapMode = "proximity" | "mandatory" | "off";

export interface StripMetrics {
  fullPanes: number;
  leftSpines: number;
  rightSpines: number;
  contentWidth: number;
  scrollLeft: number;
}

export interface SpineDisplay {
  status: boolean;
  unread: boolean;
  stripe: boolean;
}

export interface StackedPaneStripProps {
  panes: readonly FakePane[];
  focusedId: string;
  paneWidth: number;
  spineWidth: number;
  snap: SnapMode;
  gutter: boolean;
  trailingSpace: boolean;
  align: FocusAlign;
  spineDisplay: SpineDisplay;
  pulseIds: ReadonlySet<string>;
  onFocus: (paneId: string) => void;
  onClose: (paneId: string) => void;
  onMetrics: (metrics: StripMetrics) => void;
  renderPane: (
    pane: FakePane,
    context: { width: number; collapsed: boolean },
  ) => ReactNode;
}

const STATUS_LABEL: Record<FakePaneStatus, string> = {
  idle: "idle",
  running: "running",
  "needs-input": "needs input",
  error: "error",
};

const STATUS_DOT: Record<FakePaneStatus, string> = {
  idle: "bg-muted-foreground/40",
  running: "bg-primary",
  "needs-input": "bg-amber-500",
  error: "bg-destructive",
};

function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function sameFlags(left: readonly boolean[], right: readonly boolean[]) {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

export function StackedPaneStrip({
  panes,
  focusedId,
  paneWidth,
  spineWidth,
  snap,
  gutter,
  trailingSpace,
  align,
  spineDisplay,
  pulseIds,
  onFocus,
  onClose,
  onMetrics,
  renderPane,
}: StackedPaneStripProps) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const paneRefs = useRef<(HTMLElement | null)[]>([]);
  const [collapsed, setCollapsed] = useState<boolean[]>([]);
  const [viewportWidth, setViewportWidth] = useState(0);
  const frameRef = useRef(0);
  const onMetricsRef = useRef(onMetrics);
  useLayoutEffect(() => {
    onMetricsRef.current = onMetrics;
  }, [onMetrics]);
  const collapsedRef = useRef<boolean[]>([]);
  const previousFocusRef = useRef<string | null>(null);

  const measure = useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const bounds = scroller.getBoundingClientRect();
    const scale = scroller.offsetWidth > 0 ? bounds.width / scroller.offsetWidth : 1;
    const rects = paneRefs.current
      .slice(0, panes.length)
      .map((element) => element?.getBoundingClientRect() ?? null);
    const nextCollapsed: boolean[] = [];
    let fullPanes = 0;
    let leftSpines = 0;
    let rightSpines = 0;
    rects.forEach((rect, index) => {
      if (!rect) {
        nextCollapsed.push(false);
        return;
      }
      const nextRect = rects[index + 1] ?? null;
      const visibleLeft = Math.max(rect.left, bounds.left);
      const visibleRight = Math.min(
        rect.right,
        bounds.right,
        nextRect ? nextRect.left : Number.POSITIVE_INFINITY,
      );
      const visible = Math.max(0, visibleRight - visibleLeft) / scale;
      const isCollapsed = visible <= spineWidth + 1.5;
      nextCollapsed.push(isCollapsed);
      if (isCollapsed) {
        const center = (rect.left + rect.right) / 2;
        if (center < (bounds.left + bounds.right) / 2) leftSpines += 1;
        else rightSpines += 1;
      } else if (visible >= paneWidth - 1) {
        fullPanes += 1;
      }
    });
    if (!sameFlags(collapsedRef.current, nextCollapsed)) {
      collapsedRef.current = nextCollapsed;
      setCollapsed(nextCollapsed);
    }
    onMetricsRef.current({
      fullPanes,
      leftSpines,
      rightSpines,
      contentWidth: scroller.clientWidth,
      scrollLeft: Math.round(scroller.scrollLeft),
    });
  }, [panes.length, paneWidth, spineWidth]);

  const scheduleMeasure = useCallback(() => {
    cancelAnimationFrame(frameRef.current);
    frameRef.current = requestAnimationFrame(measure);
  }, [measure]);

  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    setViewportWidth(scroller.clientWidth);
    const observer = new ResizeObserver(() => {
      setViewportWidth(scroller.clientWidth);
      scheduleMeasure();
    });
    observer.observe(scroller);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frameRef.current);
    };
  }, [scheduleMeasure]);

  const scrollToPane = useCallback(
    (paneId: string, behavior: "smooth" | "instant") => {
      const scroller = scrollerRef.current;
      if (!scroller) return;
      const index = panes.findIndex((pane) => pane.id === paneId);
      if (index < 0) return;
      const maxLeft = scroller.scrollWidth - scroller.clientWidth;
      const slot = snapScrollLeft(index, paneWidth, spineWidth);
      const comingFromLeft = scroller.scrollLeft > slot;
      const reveal =
        (index + 1) * paneWidth -
        scroller.clientWidth +
        (panes.length - index - 1) * spineWidth;
      const wanted =
        align === "reveal" && !comingFromLeft ? Math.min(slot, reveal) : slot;
      const target = Math.min(maxLeft, wanted);
      scroller.scrollTo({
        left: Math.max(0, target),
        behavior:
          behavior === "smooth" && !prefersReducedMotion() ? "smooth" : "instant",
      });
    },
    [panes, paneWidth, spineWidth, align],
  );

  const isFullyVisible = useCallback(
    (paneId: string) => {
      const scroller = scrollerRef.current;
      const index = panes.findIndex((pane) => pane.id === paneId);
      const element = paneRefs.current[index];
      if (!scroller || !element) return false;
      const bounds = scroller.getBoundingClientRect();
      const rect = element.getBoundingClientRect();
      const next = paneRefs.current[index + 1]?.getBoundingClientRect() ?? null;
      const scale = scroller.offsetWidth > 0 ? bounds.width / scroller.offsetWidth : 1;
      const right = Math.min(rect.right, bounds.right);
      const left = Math.max(rect.left, bounds.left);
      const coveredBy = next ? Math.max(0, right - next.left) : 0;
      const spine = spineWidth * scale;
      return right - left - coveredBy >= paneWidth * scale - 1 && coveredBy <= spine;
    },
    [panes, paneWidth, spineWidth],
  );

  const scrollToPaneRef = useRef(scrollToPane);
  useLayoutEffect(() => {
    scrollToPaneRef.current = scrollToPane;
  }, [scrollToPane]);

  useEffect(() => {
    if (previousFocusRef.current === null) {
      scrollToPane(focusedId, "instant");
    } else if (!isFullyVisible(focusedId)) {
      scrollToPane(focusedId, "smooth");
    }
    previousFocusRef.current = focusedId;
    scheduleMeasure();
  }, [focusedId, panes.length, scrollToPane, isFullyVisible, scheduleMeasure]);

  const focusedIdRef = useRef(focusedId);
  useLayoutEffect(() => {
    focusedIdRef.current = focusedId;
  }, [focusedId]);

  useEffect(() => {
    scrollToPaneRef.current(focusedIdRef.current, "instant");
    scheduleMeasure();
  }, [paneWidth, spineWidth, viewportWidth, trailingSpace, align, scheduleMeasure]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!event.altKey || event.metaKey || event.ctrlKey) return;
    const index = panes.findIndex((pane) => pane.id === focusedId);
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      const delta = event.key === "ArrowLeft" ? -1 : 1;
      const next = panes[Math.min(panes.length - 1, Math.max(0, index + delta))];
      if (next) onFocus(next.id);
      event.preventDefault();
    } else if (event.key.toLowerCase() === "w") {
      onClose(focusedId);
      event.preventDefault();
    } else if (/^[1-9]$/.test(event.key)) {
      const target = panes[Number(event.key) - 1];
      if (target) onFocus(target.id);
      event.preventDefault();
    }
  };

  const spacer = trailingSpace
    ? trailingSpaceWidth(viewportWidth, paneWidth, spineWidth, panes.length)
    : 0;

  const scrollSnapType =
    snap === "off" ? "none" : snap === "mandatory" ? "x mandatory" : "x proximity";

  return (
    <div
      ref={scrollerRef}
      role="region"
      aria-label="Pane stack"
      onScroll={scheduleMeasure}
      onKeyDown={onKeyDown}
      className="flex h-full min-w-0 flex-1 overflow-x-auto overflow-y-hidden bg-muted/40"
      style={{ scrollSnapType, overscrollBehaviorX: "contain" }}
    >
      {panes.map((pane, index) => {
        const offsets = stickyOffsets(index, panes.length, paneWidth, spineWidth);
        const isCollapsed = collapsed[index] ?? false;
        const isFocused = pane.id === focusedId;
        const pulsing = pulseIds.has(pane.id);
        const paneStyle: CSSProperties = {
          position: "sticky",
          left: offsets.left,
          right: offsets.right,
          width: paneWidth,
          flex: "none",
          scrollSnapAlign: "start",
          scrollMarginLeft: index * spineWidth,
        };
        const showSpine = gutter || isCollapsed;
        return (
          <section
            key={pane.id}
            ref={(element) => {
              paneRefs.current[index] = element;
            }}
            role="region"
            aria-label={`${pane.title}, pane ${index + 1} of ${panes.length}`}
            data-focused={isFocused ? "true" : undefined}
            data-collapsed={isCollapsed ? "true" : undefined}
            onPointerDownCapture={() => {
              if (!isCollapsed) onFocus(pane.id);
            }}
            className={`relative h-full border-l border-border bg-background shadow-[-6px_0_12px_-8px_rgb(0_0_0/0.35)] ${
              isFocused ? "ring-1 ring-inset ring-ring" : ""
            }`}
            style={paneStyle}
          >
            <div
              inert={isCollapsed}
              className="h-full"
              style={{ paddingLeft: gutter ? spineWidth : 0 }}
            >
              {renderPane(pane, {
                width: paneWidth - (gutter ? spineWidth : 0),
                collapsed: isCollapsed,
              })}
            </div>
            <div
              className={`group absolute inset-y-0 left-0 flex flex-col items-center gap-1 border-r border-border py-2 transition-opacity duration-150 motion-reduce:transition-none ${
                pulsing ? "bg-accent" : "bg-background"
              } ${showSpine ? "opacity-100" : "pointer-events-none opacity-0"}`}
              style={{ width: spineWidth }}
              aria-hidden={showSpine ? undefined : true}
            >
              {spineDisplay.stripe ? (
                <span
                  aria-hidden
                  className="absolute inset-y-0 left-0 w-0.5"
                  style={{ background: `oklch(0.7 0.14 ${pane.hue})` }}
                />
              ) : null}
              {spineDisplay.status ? (
                <span
                  className={`mt-0.5 size-2 shrink-0 rounded-full ${STATUS_DOT[pane.status]} ${
                    pulsing ? "motion-safe:animate-ping" : ""
                  }`}
                  title={STATUS_LABEL[pane.status]}
                />
              ) : null}
              {spineDisplay.unread && pane.unread > 0 ? (
                <span className="rounded-full bg-primary px-1 text-xs leading-4 text-primary-foreground">
                  {pane.unread}
                </span>
              ) : null}
              <button
                type="button"
                tabIndex={showSpine ? 0 : -1}
                aria-label={`Show ${pane.title}, pane ${index + 1} of ${panes.length}, ${STATUS_LABEL[pane.status]}${pulsing ? ", new" : ""}`}
                onClick={() => onFocus(pane.id)}
                className="min-h-0 flex-1 cursor-pointer overflow-hidden text-ellipsis whitespace-nowrap text-sm text-muted-foreground hover:text-foreground focus-visible:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                style={{ writingMode: "vertical-rl" }}
              >
                {pane.title}
              </button>
              <button
                type="button"
                tabIndex={showSpine ? 0 : -1}
                aria-label={`Close ${pane.title}`}
                onClick={() => onClose(pane.id)}
                className="shrink-0 cursor-pointer rounded px-1 text-sm text-muted-foreground opacity-0 hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring group-hover:opacity-100"
              >
                ×
              </button>
            </div>
          </section>
        );
      })}
      {spacer > 0 ? (
        <div aria-hidden className="flex-none" style={{ width: spacer }} />
      ) : null}
    </div>
  );
}
