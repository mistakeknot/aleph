import { parseWikiPage } from "./wiki-page.js";
import type {
  WikiKind,
  WikiList,
  WikiPage,
  WikiPageError,
  WikiPageSummary,
} from "./wiki-types.js";

export const WIKI_SOURCE_DIRECTORIES: Record<WikiKind, string> = {
  cuj: "docs/wiki/src/cujs",
  requirement: "docs/wiki/src/requirements",
};

const READ_CONCURRENCY = 8;
const KIND_ORDER: Record<WikiKind, number> = { cuj: 0, requirement: 1 };

export interface WikiFileSource {
  listMarkdownFiles(directory: string): Promise<string[] | null>;
  readText(path: string): Promise<string>;
}

export interface WikiDiscovery {
  list: WikiList;
  pages: WikiPage[];
}

export function toSummary(page: WikiPage): WikiPageSummary {
  const { body: _body, claims: _claims, ...summary } = page;
  return summary;
}

function describeFailure(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function mapLimited<T, R>(
  items: T[],
  limit: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      const item = items[index];
      if (item === undefined) continue;
      results[index] = await run(item);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return results;
}

type PageOutcome =
  | { ok: true; page: WikiPage }
  | { ok: false; error: WikiPageError };

export async function discoverWiki(
  source: WikiFileSource,
): Promise<WikiDiscovery> {
  const kinds: WikiKind[] = ["cuj", "requirement"];
  const targets: { kind: WikiKind; path: string }[] = [];
  const errors: WikiPageError[] = [];
  let foundDirectory = false;

  for (const kind of kinds) {
    const directory = WIKI_SOURCE_DIRECTORIES[kind];
    let names: string[] | null;
    try {
      names = await source.listMarkdownFiles(directory);
    } catch (error) {
      errors.push({
        kind,
        path: directory,
        message: `Could not list ${directory}: ${describeFailure(error)}`,
      });
      continue;
    }
    if (names === null) continue;
    foundDirectory = true;
    for (const name of [...names].sort()) {
      targets.push({ kind, path: `${directory}/${name}` });
    }
  }

  const outcomes = await mapLimited<
    { kind: WikiKind; path: string },
    PageOutcome
  >(targets, READ_CONCURRENCY, async (target) => {
    try {
      const content = await source.readText(target.path);
      return parseWikiPage({ ...target, content });
    } catch (error) {
      return {
        ok: false,
        error: {
          ...target,
          message: `Could not read page: ${describeFailure(error)}`,
        },
      };
    }
  });

  const pages: WikiPage[] = [];
  const seen = new Set<string>();
  for (const outcome of outcomes) {
    if (!outcome.ok) {
      errors.push(outcome.error);
      continue;
    }
    if (seen.has(outcome.page.id)) {
      errors.push({
        kind: outcome.page.kind,
        path: outcome.page.path,
        message: `Duplicate page id: ${outcome.page.id}`,
        pageId: outcome.page.id,
      });
      continue;
    }
    seen.add(outcome.page.id);
    pages.push(outcome.page);
  }
  pages.sort(
    (a, b) =>
      KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.id.localeCompare(b.id),
  );

  if (pages.length === 0 && errors.length === 0) {
    return {
      pages,
      list: {
        state: "empty",
        message: foundDirectory
          ? "docs/wiki/src has no CUJ or requirement pages yet."
          : "This project has no docs/wiki/src directory yet.",
        pages: [],
        errors: [],
      },
    };
  }
  return {
    pages,
    list: {
      state: "ready",
      message: null,
      pages: pages.map(toSummary),
      errors,
    },
  };
}
