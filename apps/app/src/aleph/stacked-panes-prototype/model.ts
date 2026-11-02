export type FakePaneStatus = "idle" | "running" | "needs-input" | "error";

export type FakePaneKind = "thread" | "plugin";

export interface FakePane {
  id: string;
  title: string;
  kind: FakePaneKind;
  status: FakePaneStatus;
  unread: number;
  hue: number;
  links: string[];
}

export type LinkBehavior = "truncate" | "append";

export type LinkModifier = "none" | "append" | "replace";

const TITLES: readonly string[] = [
  "Fix thread drag sync",
  "Per-window layouts design",
  "Matuschak-style stacked panes",
  "Timeline scrollback regression",
  "Composer queue ordering",
  "Home owed picks",
  "Host daemon reconnect",
  "Provider usage rollup",
  "Sidebar row virtualization",
  "Archive cleanup for split panes",
  "Plugin panel density",
  "Secrets request flow",
  "Workflow run history",
  "Diff worker pool sizing",
  "Cold tier reader audit",
  "Release notes draft",
  "Multi-device presence",
  "Search palette ranking",
  "Terminal resize flicker",
  "Account pool headroom",
];

const STATUSES: readonly FakePaneStatus[] = [
  "idle",
  "running",
  "idle",
  "needs-input",
  "idle",
  "error",
  "running",
  "idle",
];

export const POOL_SIZE = TITLES.length;

export function hashString(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function paneIdForIndex(index: number): string {
  return `fake_${String(index % POOL_SIZE).padStart(2, "0")}`;
}

function poolIndexFromId(id: string): number {
  const parsed = Number.parseInt(id.slice("fake_".length), 10);
  return Number.isFinite(parsed) ? parsed % POOL_SIZE : 0;
}

export function makeFakePane(id: string): FakePane {
  const index = poolIndexFromId(id);
  const seed = hashString(id);
  const links: string[] = [];
  for (let step = 1; links.length < 3 && step < POOL_SIZE; step += 1) {
    const candidate = paneIdForIndex(index + 1 + ((seed >>> (step * 3)) % (POOL_SIZE - 1)));
    if (candidate !== id && !links.includes(candidate)) links.push(candidate);
  }
  const isPlugin = index === 5 || index === 10;
  return {
    id,
    title: TITLES[index] ?? id,
    kind: isPlugin ? "plugin" : "thread",
    status: STATUSES[seed % STATUSES.length] ?? "idle",
    unread: seed % 5 === 0 ? (seed % 7) + 1 : 0,
    hue: seed % 360,
    links,
  };
}

export function makeInitialStack(count: number): FakePane[] {
  const panes: FakePane[] = [];
  for (let index = 0; index < count; index += 1) {
    panes.push(makeFakePane(paneIdForIndex(index * 3)));
  }
  return dedupePanes(panes, count);
}

function dedupePanes(panes: FakePane[], count: number): FakePane[] {
  const seen = new Set<string>();
  const result: FakePane[] = [];
  for (const pane of panes) {
    if (!seen.has(pane.id)) {
      seen.add(pane.id);
      result.push(pane);
    }
  }
  let cursor = 0;
  while (result.length < count && cursor < POOL_SIZE) {
    const id = paneIdForIndex(cursor);
    if (!seen.has(id)) {
      seen.add(id);
      result.push(makeFakePane(id));
    }
    cursor += 1;
  }
  return result;
}

export interface StackUpdate {
  panes: FakePane[];
  focusedId: string;
}

export function appendPane(
  panes: readonly FakePane[],
  targetId: string,
): StackUpdate {
  const existing = panes.find((pane) => pane.id === targetId);
  if (existing) return { panes: [...panes], focusedId: existing.id };
  const next = makeFakePane(targetId);
  return { panes: [...panes, next], focusedId: next.id };
}

export function pushFromPane(
  panes: readonly FakePane[],
  sourceId: string,
  targetId: string,
  behavior: LinkBehavior,
  modifier: LinkModifier,
): StackUpdate {
  const sourceIndex = panes.findIndex((pane) => pane.id === sourceId);
  const existing = panes.find((pane) => pane.id === targetId);
  if (sourceIndex < 0) return appendPane(panes, targetId);
  if (existing) return { panes: [...panes], focusedId: existing.id };
  const next = makeFakePane(targetId);
  if (modifier === "replace") {
    const replaced = [...panes];
    replaced[sourceIndex] = next;
    return { panes: replaced, focusedId: next.id };
  }
  const truncates = modifier === "none" && behavior === "truncate";
  const result = truncates
    ? [...panes.slice(0, sourceIndex + 1), next]
    : [...panes, next];
  return { panes: result, focusedId: next.id };
}

export function closePane(
  panes: readonly FakePane[],
  paneId: string,
  focusedId: string,
): StackUpdate {
  const index = panes.findIndex((pane) => pane.id === paneId);
  if (index < 0 || panes.length <= 1) {
    return { panes: [...panes], focusedId };
  }
  const result = panes.filter((pane) => pane.id !== paneId);
  if (focusedId !== paneId) return { panes: result, focusedId };
  const neighbour = result[Math.max(0, index - 1)];
  return { panes: result, focusedId: neighbour?.id ?? focusedId };
}

export function snapScrollLeft(
  index: number,
  paneWidth: number,
  spineWidth: number,
): number {
  return index * (paneWidth - spineWidth);
}

export function trailingSpaceWidth(
  viewportWidth: number,
  paneWidth: number,
  spineWidth: number,
  paneCount: number,
): number {
  return Math.max(0, viewportWidth - paneWidth - (paneCount - 1) * spineWidth);
}

export function stickyOffsets(
  index: number,
  paneCount: number,
  paneWidth: number,
  spineWidth: number,
): { left: number; right: number } {
  return {
    left: index * spineWidth,
    right: (paneCount - index) * spineWidth - paneWidth,
  };
}
