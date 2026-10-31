import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAtomValue, useStore } from "jotai";
import { useLocation, useNavigate } from "react-router-dom";
import { Button } from "@bb/shared-ui/button";
import type { WindowReport } from "@bb/domain";
import { useUiPreferences } from "@/hooks/queries/system-queries";
import { sdk } from "@/lib/sdk";
import { maximizedPaneIdAtom, splitLayoutAtom } from "@/lib/split-layout/atoms";
import { listPanes } from "@/lib/split-layout/ops";
import { focusedPaneRoute } from "@/views/thread-detail/splitThreadNavigation";
import { sidebarOpenAtom } from "@/components/layout/sidebar-open-atom";
import {
  windowPresetsAtom,
  windowSuggestionsAtom,
} from "@/lib/window-presets/atoms";
import {
  buildPresetLayout,
  presetPanesEqual,
  resolvePresetContents,
} from "@/lib/window-presets/resolve";
import { useWindowPresetThreads } from "@/lib/window-presets/useWindowPresetThreads";
import {
  getAppliedPresetId,
  getWindowId,
  setAppliedPresetId,
} from "@/lib/window-presets/window-id";

const REPORT_DEBOUNCE_MS = 400;
const REPORT_HEARTBEAT_MS = 30_000;

function requestedPresetId(search: string): string | null {
  const value = new URLSearchParams(search).get("preset");
  return value !== null && value.length > 0 ? value : null;
}

export function WindowPresetController() {
  const location = useLocation();
  const navigate = useNavigate();
  const store = useStore();
  const requested = requestedPresetId(location.search);
  const { data: preferences } = useUiPreferences();
  const preferencesReady = preferences !== undefined;
  const presets = useAtomValue(windowPresetsAtom);
  const suggestions = useAtomValue(windowSuggestionsAtom);
  const layout = useAtomValue(splitLayoutAtom);
  const maximizedPaneId = useAtomValue(maximizedPaneIdAtom);
  const sidebarOpen = useAtomValue(sidebarOpenAtom);
  const [activePresetId, setActivePresetId] = useState<string | null>(() =>
    getAppliedPresetId(),
  );
  const threadsQuery = useWindowPresetThreads(true);
  const threads = threadsQuery.data;

  useEffect(() => {
    if (requested === null || !preferencesReady || threads === undefined) {
      return;
    }
    if (getAppliedPresetId() === requested) {
      return;
    }
    const target = presets.find((candidate) => candidate.id === requested);
    if (target === undefined) {
      return;
    }
    const contents = resolvePresetContents(target.panes, threads);
    const nextLayout = buildPresetLayout(contents, target.direction);
    store.set(splitLayoutAtom, nextLayout);
    store.set(maximizedPaneIdAtom, null);
    if (target.hideSidebar) {
      store.set(sidebarOpenAtom, false);
    }
    setAppliedPresetId(target.id);
    setActivePresetId(target.id);
    void navigate(focusedPaneRoute(nextLayout) ?? "/", { replace: true });
  }, [requested, preferencesReady, threads, presets, store, navigate]);

  const titleById = useMemo(() => {
    const map = new Map<string, string | null>();
    for (const thread of threads ?? []) {
      map.set(thread.id, thread.title ?? thread.titleFallback);
    }
    return map;
  }, [threads]);

  const buildReport = useCallback((): WindowReport => {
    const panes = (layout === null ? [] : listPanes(layout.root)).map(
      (pane) => ({
        paneId: pane.paneId,
        kind: pane.content.kind,
        projectId:
          pane.content.kind === "thread" ? pane.content.projectId : null,
        threadId: pane.content.kind === "thread" ? pane.content.threadId : null,
        threadTitle:
          pane.content.kind === "thread"
            ? (titleById.get(pane.content.threadId) ?? null)
            : null,
        pluginId:
          pane.content.kind === "plugin-panel" ||
          pane.content.kind === "plugin-detail"
            ? pane.content.pluginId
            : null,
        panelPath:
          pane.content.kind === "plugin-panel" ? pane.content.panelPath : null,
        focused: layout !== null && pane.paneId === layout.focusedPaneId,
      }),
    );
    return {
      windowId: getWindowId(),
      presetId: activePresetId,
      route: `${location.pathname}${location.search}`.slice(0, 2_048),
      sidebarOpen,
      rightPanelOpen: false,
      rightPanelTab: null,
      maximizedPaneId,
      panes: panes.slice(0, 8),
      viewport: {
        width: Math.round(window.innerWidth),
        height: Math.round(window.innerHeight),
      },
    };
  }, [
    layout,
    titleById,
    activePresetId,
    location.pathname,
    location.search,
    sidebarOpen,
    maximizedPaneId,
  ]);

  const buildReportRef = useRef(buildReport);
  buildReportRef.current = buildReport;

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void sdk.system.windows.report(buildReportRef.current()).catch(() => {});
    }, REPORT_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [buildReport]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      void sdk.system.windows.report(buildReportRef.current()).catch(() => {});
    }, REPORT_HEARTBEAT_MS);
    return () => window.clearInterval(interval);
  }, []);

  const suggestion =
    activePresetId === null ? undefined : suggestions[activePresetId];
  const preset = presets.find((candidate) => candidate.id === activePresetId);
  const showSuggestion =
    suggestion !== undefined &&
    preset !== undefined &&
    preset.userEditable &&
    !presetPanesEqual(suggestion.panes, preset.panes);

  const dismiss = useCallback(() => {
    if (activePresetId === null || suggestion === undefined) {
      return;
    }
    void sdk.system.windows
      .dismissSuggestion({
        presetId: activePresetId,
        suggestionId: suggestion.suggestionId,
      })
      .catch(() => {});
  }, [activePresetId, suggestion]);

  const accept = useCallback(() => {
    if (
      activePresetId === null ||
      suggestion === undefined ||
      threads === undefined
    ) {
      return;
    }
    const direction = preset?.direction ?? "row";
    void sdk.system.windows
      .acceptSuggestion({
        presetId: activePresetId,
        windowId: getWindowId(),
        suggestionId: suggestion.suggestionId,
      })
      .then(({ panes }) => {
        const contents = resolvePresetContents(panes, threads);
        const nextLayout = buildPresetLayout(contents, direction);
        store.set(splitLayoutAtom, nextLayout);
        store.set(maximizedPaneIdAtom, null);
        void navigate(focusedPaneRoute(nextLayout) ?? "/", { replace: true });
      })
      .catch(() => {});
  }, [activePresetId, suggestion, threads, preset, store, navigate]);

  if (!showSuggestion || suggestion === undefined) {
    return null;
  }
  return (
    <div
      role="status"
      data-testid="window-preset-suggestion"
      className="fixed right-4 bottom-4 z-50 flex max-w-sm flex-col gap-2 rounded-lg border bg-popover p-3 text-sm shadow-lg"
    >
      <div className="font-medium">
        {suggestion.proposedBy} suggests a new layout for {preset?.name}
      </div>
      {suggestion.reason !== null ? (
        <div className="text-muted-foreground">{suggestion.reason}</div>
      ) : null}
      <div className="flex gap-2">
        <Button size="sm" onClick={accept}>
          Update to suggested
        </Button>
        <Button size="sm" variant="ghost" onClick={dismiss}>
          Dismiss
        </Button>
      </div>
    </div>
  );
}
