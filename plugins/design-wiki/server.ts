import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  designWikiRpcContract,
  type WikiPageResult,
  type WikiProject,
} from "./contract.js";
import {
  discoverWiki,
  type WikiDiscovery,
  type WikiFileSource,
} from "./wiki-discovery.js";
import type { WikiList } from "./wiki-types.js";

const MAX_LISTED_FILES = 500;
const MAX_PAGE_BYTES = 512 * 1024;
const MISSING_PATH_PATTERN =
  /not found|no such|enoent|does not exist|not a directory/i;

interface CheckoutRoot {
  hostId: string;
  path: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissingPath(error: unknown): boolean {
  if (typeof error === "object" && error !== null && "status" in error) {
    if (error.status === 404) return true;
  }
  return MISSING_PATH_PATTERN.test(errorMessage(error));
}

export default async function designWikiPlugin(bb: BbPluginApi): Promise<void> {
  async function checkoutRoot(projectId: string): Promise<CheckoutRoot | null> {
    const project = await bb.sdk.projects.get({ projectId });
    const source =
      project.sources.find((candidate) => candidate.isDefault) ??
      project.sources[0];
    return source === undefined
      ? null
      : { hostId: source.hostId, path: source.path };
  }

  function fileSource(root: CheckoutRoot): WikiFileSource {
    return {
      async listMarkdownFiles(directory) {
        const absolute = `${root.path}/${directory}`;
        let result: Awaited<ReturnType<BbPluginApi["sdk"]["files"]["listPaths"]>>;
        try {
          result = await bb.sdk.files.listPaths({
            hostId: root.hostId,
            path: absolute,
            includeFiles: true,
            includeDirectories: false,
            includeHidden: false,
            limit: MAX_LISTED_FILES,
          });
        } catch (error) {
          if (isMissingPath(error)) return null;
          throw error;
        }
        const names: string[] = [];
        for (const entry of result.paths) {
          if (entry.kind !== "file") continue;
          const relative = entry.path.startsWith(`${absolute}/`)
            ? entry.path.slice(absolute.length + 1)
            : entry.path;
          if (relative.includes("/") || !relative.endsWith(".md")) continue;
          names.push(relative);
        }
        return names;
      },
      async readText(path) {
        const file = await bb.sdk.files.read({
          hostId: root.hostId,
          path: `${root.path}/${path}`,
          rootPath: root.path,
        });
        if (file.contentEncoding !== "utf8") {
          throw new Error("The page is not a text file");
        }
        if (file.sizeBytes > MAX_PAGE_BYTES) {
          throw new Error("The page is larger than 512 KB");
        }
        return file.content;
      },
    };
  }

  async function discover(projectId: string): Promise<WikiDiscovery> {
    let root: CheckoutRoot | null;
    try {
      root = await checkoutRoot(projectId);
    } catch (error) {
      return unavailable(`Could not open the project: ${errorMessage(error)}`);
    }
    if (root === null) {
      return unavailable("This project has no checkout on any host.");
    }
    try {
      return await discoverWiki(fileSource(root));
    } catch (error) {
      bb.log.warn(`design wiki discovery failed: ${errorMessage(error)}`);
      return unavailable(`Could not read the wiki: ${errorMessage(error)}`);
    }
  }

  function unavailable(message: string): WikiDiscovery {
    const list: WikiList = {
      state: "unavailable",
      message,
      pages: [],
      errors: [],
    };
    return { list, pages: [] };
  }

  bb.rpc.register(
    designWikiRpcContract,
    {
      async projects(): Promise<WikiProject[]> {
        const projects = await bb.sdk.projects.list({ includePersonal: true });
        return projects.map((project) => ({
          id: project.id,
          name: project.name,
          hasCheckout: project.sources.length > 0,
        }));
      },
      async list({ projectId }) {
        return (await discover(projectId)).list;
      },
      async page({ projectId, pageId }): Promise<WikiPageResult> {
        const found = (await discover(projectId)).pages.find(
          (page) => page.id === pageId,
        );
        return found === undefined
          ? { state: "missing" }
          : { state: "found", page: found };
      },
    },
    {
      experimental_discoverable: true,
      experimental_description:
        "Read-only project design wiki: CUJ and requirement pages kept in the project's repository.",
    },
  );
}
