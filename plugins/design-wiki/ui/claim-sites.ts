import type { ClaimSite } from "../claims.js";

export const CLAIM_MENU_TAG = "wiki-claim-menu";

export interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
  position?: { start?: { line?: number } };
}

interface Visit {
  node: HastNode;
  parent: HastNode | null;
}

function textOf(node: HastNode): string {
  if (node.type === "text") return node.value ?? "";
  return (node.children ?? []).map(textOf).join("");
}

function collect(root: HastNode): Visit[] {
  const visits: Visit[] = [];
  const stack: Visit[] = [{ node: root, parent: null }];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) break;
    visits.push(current);
    const children = current.node.children ?? [];
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index];
      if (child !== undefined)
        stack.push({ node: child, parent: current.node });
    }
  }
  return visits;
}

function lineOf(node: HastNode): number | null {
  return node.position?.start?.line ?? null;
}

function columnOf(cell: HastNode, row: HastNode): number {
  const cells = (row.children ?? []).filter(
    (child) =>
      child.type === "element" &&
      (child.tagName === "td" || child.tagName === "th"),
  );
  return cells.indexOf(cell);
}

function own(node: HastNode, claimIndex: number): void {
  node.properties = { ...node.properties, dataClaimIndex: String(claimIndex) };
}

export function claimIndexOf(node: HastNode | undefined): number | null {
  const raw = node?.properties?.["dataClaimIndex"];
  if (typeof raw !== "string") return null;
  const parsed = Number(raw);
  return Number.isInteger(parsed) ? parsed : null;
}

export function unmappedOf(node: HastNode | undefined): number[] {
  const raw = node?.properties?.["dataUnmapped"];
  if (typeof raw !== "string" || raw === "") return [];
  return raw
    .split(",")
    .map(Number)
    .filter((value) => Number.isInteger(value));
}

export function createClaimMapper(sites: ClaimSite[]) {
  return () => (tree: HastNode) => {
    const owned = new Set<number>();
    const strongsByLine = new Map<number, HastNode[]>();
    for (const { node, parent } of collect(tree)) {
      if (node.type !== "element") continue;
      const line = lineOf(node);
      if (line === null) continue;
      if (node.tagName === "strong") {
        const onLine = strongsByLine.get(line) ?? [];
        onLine.push(node);
        strongsByLine.set(line, onLine);
        continue;
      }
      if ((node.tagName === "td" || node.tagName === "th") && parent !== null) {
        const column = columnOf(node, parent);
        const index = sites.findIndex(
          (site) =>
            site.site === "cell" &&
            site.line === line &&
            site.siteIndex === column,
        );
        if (index >= 0 && !owned.has(index)) {
          owned.add(index);
          own(node, index);
        }
      }
    }
    for (const [line, strongs] of strongsByLine) {
      const candidates = sites
        .map((site, index) => ({ site, index }))
        .filter(
          ({ site, index }) =>
            site.site === "strong" && site.line === line && !owned.has(index),
        );
      let cursor = 0;
      for (const strong of strongs) {
        const text = textOf(strong).trim();
        const found = candidates.findIndex(
          (candidate, position) =>
            position >= cursor && candidate.site.label === text,
        );
        if (found < 0) continue;
        const match = candidates[found];
        if (match === undefined) continue;
        owned.add(match.index);
        own(strong, match.index);
        cursor = found + 1;
      }
    }
    const unmapped = sites
      .map((_site, index) => index)
      .filter((index) => !owned.has(index));
    if (unmapped.length === 0) return;
    tree.children = [
      ...(tree.children ?? []),
      {
        type: "element",
        tagName: CLAIM_MENU_TAG,
        properties: { dataUnmapped: unmapped.join(",") },
        children: [],
      },
    ];
  };
}
