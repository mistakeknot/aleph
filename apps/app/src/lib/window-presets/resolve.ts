import type { WindowPreset, WindowPresetPane } from "@bb/domain";
import { MAX_PANES } from "@/lib/split-layout/ops";
import type {
  LayoutNode,
  PaneContent,
  PaneNode,
  SplitLayout,
} from "@/lib/split-layout/types";

export interface PresetThreadCandidate {
  id: string;
  projectId: string;
  title: string | null;
  titleFallback: string | null;
  pinnedAt: number | null;
  updatedAt: number;
}

function candidateTitle(thread: PresetThreadCandidate): string {
  return thread.title ?? thread.titleFallback ?? "";
}

export function resolvePresetPane(
  pane: WindowPresetPane,
  threads: readonly PresetThreadCandidate[],
): PaneContent | null {
  if (pane.kind === "thread") {
    return {
      kind: "thread",
      projectId: pane.projectId,
      threadId: pane.threadId,
    };
  }
  if (pane.kind === "plugin-panel") {
    return {
      kind: "plugin-panel",
      pluginId: pane.pluginId,
      panelPath: pane.panelPath,
      subPath: pane.subPath ?? "",
    };
  }
  const match = threads
    .filter(
      (thread) =>
        candidateTitle(thread).startsWith(pane.titlePrefix) &&
        (pane.pinnedOnly !== true || thread.pinnedAt !== null),
    )
    .sort((a, b) => b.updatedAt - a.updatedAt)[0];
  if (match === undefined) {
    return null;
  }
  return { kind: "thread", projectId: match.projectId, threadId: match.id };
}

export function resolvePresetContents(
  panes: readonly WindowPresetPane[],
  threads: readonly PresetThreadCandidate[],
): PaneContent[] {
  const contents: PaneContent[] = [];
  for (const pane of panes.slice(0, MAX_PANES)) {
    const content = resolvePresetPane(pane, threads);
    if (content !== null) {
      contents.push(content);
    }
  }
  return contents;
}

export function buildPresetLayout(
  contents: readonly PaneContent[],
  direction: WindowPreset["direction"],
): SplitLayout {
  const panes: PaneNode[] = contents.map((content, index) => ({
    type: "pane",
    paneId: `pane-${index + 1}`,
    content,
  }));
  if (panes.length === 0) {
    return {
      root: { type: "pane", paneId: "pane-1", content: { kind: "new-thread" } },
      focusedPaneId: "pane-1",
    };
  }
  const first = panes[0];
  if (panes.length === 1 && first !== undefined) {
    return { root: first, focusedPaneId: first.paneId };
  }
  const root: LayoutNode = {
    type: "split",
    dir: direction,
    sizes: panes.map(() => 1 / panes.length),
    children: panes,
  };
  return { root, focusedPaneId: panes[panes.length - 1]?.paneId ?? "pane-1" };
}

export function paneContentToPresetPane(
  content: PaneContent,
): WindowPresetPane | null {
  if (content.kind === "thread") {
    return {
      kind: "thread",
      projectId: content.projectId,
      threadId: content.threadId,
    };
  }
  if (content.kind === "plugin-panel") {
    return {
      kind: "plugin-panel",
      pluginId: content.pluginId,
      panelPath: content.panelPath,
      subPath: content.subPath,
    };
  }
  return null;
}

export function presetPanesEqual(
  a: readonly WindowPresetPane[],
  b: readonly WindowPresetPane[],
): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
