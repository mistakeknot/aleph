import { parse } from "yaml";
import { extractClaimMarkers } from "./claims.js";
import {
  WIKI_STATUSES,
  type WikiKind,
  type WikiPage,
  type WikiPageError,
  type WikiStatus,
} from "./wiki-types.js";

export {
  classifyClaimText,
  extractClaimMarkers,
  splitCardRefs,
  type CardRefSegment,
} from "./claims.js";

export type ParsedWikiPage =
  | { ok: true; page: WikiPage }
  | { ok: false; error: WikiPageError };

const FRONT_MATTER_KEYS = ["id", "status", "card", "source", "updated"];
const ID_PREFIX: Record<WikiKind, string> = { cuj: "cuj-", requirement: "req-" };
const ID_PATTERN = /^(?:cuj|req)-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CARD_KEY_PATTERN = /^[A-Z][A-Z0-9]{1,9}-\d+$/;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const FENCE_PATTERN = /^\s{0,3}(```|~~~)/;

export interface ParseWikiPageInput {
  kind: WikiKind;
  path: string;
  content: string;
}

function fail(
  input: ParseWikiPageInput,
  message: string,
): { ok: false; error: WikiPageError } {
  return { ok: false, error: { kind: input.kind, path: input.path, message } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function splitFrontMatter(
  content: string,
): { frontMatter: string; body: string } | null {
  const lines = content.replace(/^﻿/, "").split(/\r?\n/);
  if (lines[0] !== "---") return null;
  const end = lines.indexOf("---", 1);
  if (end === -1) return null;
  return {
    frontMatter: lines.slice(1, end).join("\n"),
    body: lines.slice(end + 1).join("\n"),
  };
}

function isRealDate(value: string): boolean {
  const match = DATE_PATTERN.exec(value);
  if (!match) return false;
  const [year, month, day] = [match[1], match[2], match[3]].map(Number);
  if (year === undefined || month === undefined || day === undefined) {
    return false;
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function isRepoRelativeMarkdown(value: string): boolean {
  if (!value.endsWith(".md")) return false;
  if (value.startsWith("/") || value.includes("\\") || /^[A-Za-z]:/.test(value)) {
    return false;
  }
  return !value.split("/").some((part) => part === ".." || part === "");
}

function bodyTitle(body: string): string | null {
  let fenced = false;
  for (const line of body.split("\n")) {
    if (FENCE_PATTERN.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const match = /^#\s+(.+?)\s*#*\s*$/.exec(line);
    if (match?.[1]) return match[1];
  }
  return null;
}

export function parseWikiPage(input: ParseWikiPageInput): ParsedWikiPage {
  const split = splitFrontMatter(input.content);
  if (split === null) {
    return fail(input, "Missing or unterminated front matter");
  }
  let data: unknown;
  try {
    data = parse(split.frontMatter, { maxAliasCount: 0 });
  } catch (error) {
    const reason = error instanceof Error ? error.message.split("\n")[0] : "";
    return fail(input, `Front matter is not valid YAML: ${reason}`);
  }
  if (!isRecord(data)) {
    return fail(input, "Front matter must be a mapping of fields");
  }

  const problems: string[] = [];
  const fields: Record<string, string> = {};
  for (const key of FRONT_MATTER_KEYS) {
    const value = data[key];
    if (value === undefined || value === null) {
      problems.push(`Missing front matter field: ${key}`);
    } else if (typeof value !== "string") {
      problems.push(`Front matter field ${key} must be a string`);
    } else {
      fields[key] = value.trim();
    }
  }
  for (const key of Object.keys(data)) {
    if (!FRONT_MATTER_KEYS.includes(key)) {
      problems.push(`Unknown front matter field: ${key}`);
    }
  }

  const { id, status, card, source, updated } = fields;
  if (id !== undefined) {
    if (!ID_PATTERN.test(id)) {
      problems.push(`id "${id}" must look like cuj-* or req-*`);
    } else if (!id.startsWith(ID_PREFIX[input.kind])) {
      problems.push(
        `id "${id}" must start with ${ID_PREFIX[input.kind]} for a ${input.kind} page`,
      );
    }
  }
  let pageStatus: WikiStatus | null = null;
  if (status !== undefined) {
    const known = WIKI_STATUSES.find((candidate) => candidate === status);
    if (known === undefined) {
      problems.push(
        `status "${status}" must be one of ${WIKI_STATUSES.join(", ")}`,
      );
    } else {
      pageStatus = known;
    }
  }
  if (card !== undefined) {
    if (card === "" && pageStatus === "ruled") {
      problems.push("A ruled page needs a card key");
    } else if (card !== "" && !CARD_KEY_PATTERN.test(card)) {
      problems.push(`card "${card}" must be a task key such as ABC-123`);
    }
  }
  if (source !== undefined && !isRepoRelativeMarkdown(source)) {
    problems.push("source must be a repo-relative Markdown path");
  }
  if (updated !== undefined && !isRealDate(updated)) {
    problems.push(`updated "${updated}" must be a real YYYY-MM-DD date`);
  }

  const title = bodyTitle(split.body);
  if (title === null) problems.push("Missing H1 title");

  if (
    problems.length > 0 ||
    id === undefined ||
    pageStatus === null ||
    card === undefined ||
    source === undefined ||
    updated === undefined ||
    title === null
  ) {
    return fail(input, problems.join("; "));
  }
  const body = split.body.replace(/^\n+/, "");
  return {
    ok: true,
    page: {
      id,
      kind: input.kind,
      path: input.path,
      title,
      status: pageStatus,
      card: card === "" ? null : card,
      source,
      updated,
      body,
      claims: extractClaimMarkers(body),
    },
  };
}
