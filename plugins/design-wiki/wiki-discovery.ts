import { parseWikiPage } from "./wiki-page.js";
import { parseCujgelPage } from "./cujgel-page.js";
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

export class WikiSourceRejectedError extends Error {}

export interface WikiFileSource {
  listJsonFiles?(directory: string): Promise<string[] | null>;
  listMarkdownFiles(directory: string): Promise<string[] | null>;
  readText(path: string): Promise<string>;
}

export interface WikiDiscovery {
  list: WikiList;
  pages: WikiPage[];
  incomplete?: boolean;
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
  | { ok: false; transient?: boolean; error: WikiPageError };

export async function discoverWiki(
  source: WikiFileSource,
): Promise<WikiDiscovery> {
  const kinds: WikiKind[] = ["cuj", "requirement"];
  const targets: { kind: WikiKind; path: string }[] = [];
  const errors: WikiPageError[] = [];
  let foundDirectory = false;
  let incomplete = false;

  for (const kind of kinds) {
    const directory = WIKI_SOURCE_DIRECTORIES[kind];
    let names: string[] | null;
    try {
      names = await source.listMarkdownFiles(directory);
    } catch (error) {
      if (!(error instanceof WikiSourceRejectedError)) incomplete = true;
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

  if (source.listJsonFiles !== undefined) {
    try {
      const names = await source.listJsonFiles("docs/cujs");
      if (names !== null) foundDirectory = true;
      for (const name of names ?? []) {
        if (
          !name.endsWith(".json") ||
          name
            .split("/")
            .some((part) => !part || part === "." || part === "..") ||
          /[\\:]/.test(name)
        ) {
          incomplete = true;
          errors.push({
            kind: "cuj",
            path: "docs/cujs",
            message: "Unsafe spec path",
          });
          continue;
        }
        targets.push({ kind: "cuj", path: `docs/cujs/${name}` });
      }
    } catch (error) {
      if (!(error instanceof WikiSourceRejectedError)) incomplete = true;
      errors.push({
        kind: "cuj",
        path: "docs/cujs",
        message: describeFailure(error),
      });
    }
  }

  const outcomes = await mapLimited<
    { kind: WikiKind; path: string },
    PageOutcome
  >(targets, READ_CONCURRENCY, async (target) => {
    try {
      const content = await source.readText(target.path);
      return target.path.endsWith(".json")
        ? parseCujgelPage({ path: target.path, content })
        : parseWikiPage({ ...target, content });
    } catch (error) {
      return {
        ok: false,
        transient: !(error instanceof WikiSourceRejectedError),
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
      if (outcome.transient === true) incomplete = true;
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
  const conflicts = new Set(
    errors.flatMap((error) =>
      error.pageId?.startsWith("cujgel:") ? [error.pageId] : [],
    ),
  );
  for (let index = pages.length - 1; index >= 0; index--) {
    const page = pages[index];
    if (page !== undefined && conflicts.has(page.id)) {
      errors.push({
        kind: page.kind,
        path: page.path,
        pageId: page.id,
        message: `Duplicate page id: ${page.id}`,
      });
      pages.splice(index, 1);
    }
  }
  pages.sort(
    (a, b) =>
      KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.id.localeCompare(b.id),
  );

  if (pages.length === 0 && errors.length === 0) {
    return {
      pages,
      incomplete,
      list: {
        state: "empty",
        message: foundDirectory
          ? "docs/wiki/src and docs/cujs have no CUJ or requirement pages yet."
          : "This project has no docs/wiki/src or docs/cujs directory yet.",
        pages: [],
        errors: [],
      },
    };
  }
  return {
    pages,
    incomplete,
    list: {
      state: "ready",
      message: null,
      pages: pages.map(toSummary),
      errors,
    },
  };
}
