import type { ClaimMarker, WikiStatus } from "./wiki-types.js";

const CARD_REF_PATTERN = /\b([A-Z][A-Z0-9]{1,9})-(\d+)((?:[/–]\d+)*)/g;
const CLAIM_PATTERN = /^(Ruled|Design choice|Open)(?=$|\s*[:—–-]|\s+at\b)/;
const FENCE_PATTERN = /^\s{0,3}(`{3,}|~{3,})(.*)$/;

const CLAIM_STATUS: Record<string, WikiStatus> = {
  Ruled: "ruled",
  "Design choice": "design-choice",
  Open: "open",
};

export type CardRefSegment =
  | { kind: "text"; text: string }
  | { kind: "card"; key: string; text: string };

export function splitCardRefs(text: string): CardRefSegment[] {
  const segments: CardRefSegment[] = [];
  let cursor = 0;
  const push = (segment: CardRefSegment) => {
    const last = segments[segments.length - 1];
    if (segment.kind === "text" && last?.kind === "text") {
      last.text += segment.text;
      return;
    }
    if (segment.kind === "text" && segment.text === "") return;
    segments.push(segment);
  };
  for (const match of text.matchAll(CARD_REF_PATTERN)) {
    const [whole, prefix, first, rest] = match;
    if (prefix === undefined || first === undefined) continue;
    push({ kind: "text", text: text.slice(cursor, match.index) });
    push({
      kind: "card",
      key: `${prefix}-${first}`,
      text: `${prefix}-${first}`,
    });
    for (const part of (rest ?? "").matchAll(/([/–])(\d+)/g)) {
      const [, separator, number] = part;
      if (separator === undefined || number === undefined) continue;
      push({ kind: "text", text: separator });
      push({ kind: "card", key: `${prefix}-${number}`, text: number });
    }
    cursor = match.index + whole.length;
  }
  push({ kind: "text", text: text.slice(cursor) });
  return segments.length === 0 ? [{ kind: "text", text }] : segments;
}

export function classifyClaimText(
  text: string,
): Pick<ClaimMarker, "status" | "label" | "cards"> | null {
  const label = text.trim();
  const match = CLAIM_PATTERN.exec(label);
  const word = match?.[1];
  if (word === undefined) return null;
  const status = CLAIM_STATUS[word];
  if (status === undefined) return null;
  const cards = splitCardRefs(label.slice(word.length)).flatMap((segment) =>
    segment.kind === "card" ? [segment.key] : [],
  );
  return { status, label, cards };
}

function tableCells(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|")) return null;
  return trimmed
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim());
}

export function createFenceTracker(): (line: string) => boolean {
  let open: { char: string; length: number } | null = null;
  return (line) => {
    const match = FENCE_PATTERN.exec(line);
    const marker = match?.[1];
    const rest = match?.[2] ?? "";
    if (open === null) {
      if (marker === undefined) return false;
      if (marker.startsWith("`") && rest.includes("`")) return false;
      open = { char: marker.charAt(0), length: marker.length };
      return true;
    }
    if (
      marker !== undefined &&
      marker.startsWith(open.char) &&
      marker.length >= open.length &&
      rest.trim() === ""
    ) {
      open = null;
    }
    return true;
  };
}

export type ClaimSite = ClaimMarker & {
  site: "strong" | "cell";
  siteIndex: number;
};

export function extractClaimSites(body: string): ClaimSite[] {
  const sites: ClaimSite[] = [];
  const skipFenced = createFenceTracker();
  body.split("\n").forEach((rawLine, index) => {
    const line = rawLine.replace(/\r$/, "");
    if (skipFenced(line)) return;
    const lineNumber = index + 1;
    let strongIndex = 0;
    for (const match of line.matchAll(/\*\*([^*]+)\*\*/g)) {
      const claim = match[1] ? classifyClaimText(match[1]) : null;
      if (!claim) continue;
      sites.push({
        ...claim,
        line: lineNumber,
        site: "strong",
        siteIndex: strongIndex,
      });
      strongIndex += 1;
    }
    (tableCells(line) ?? []).forEach((cell, column) => {
      if (cell.startsWith("**")) return;
      const claim = classifyClaimText(cell);
      if (claim) {
        sites.push({
          ...claim,
          line: lineNumber,
          site: "cell",
          siteIndex: column,
        });
      }
    });
  });
  return sites;
}

export function extractClaimMarkers(body: string): ClaimMarker[] {
  return extractClaimSites(body).map(
    ({ site: _site, siteIndex: _siteIndex, ...marker }) => marker,
  );
}
