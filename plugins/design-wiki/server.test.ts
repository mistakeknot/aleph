import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { wikiPageResultSchema } from "./contract.js";
import plugin from "./server.js";
import { wikiListSchema } from "./wiki-types.js";

const ROOT = "/work/proj";

function page(id: string, status: string, card: string, title: string) {
  return `---\nid: ${id}\nstatus: ${status}\ncard: "${card}"\nsource: docs/x.md\nupdated: 2026-11-03\n---\n\n# ${title}\n\n**Ruled — ACME-1:** claim.\n`;
}

interface FakeOptions {
  files?: Record<string, string>;
  sources?: { hostId: string; path: string; isDefault: boolean }[];
  failProject?: boolean;
  listError?: Error;
}

async function setup(options: FakeOptions = {}) {
  const files = options.files ?? {};
  const sources = options.sources ?? [
    { hostId: "host-1", path: ROOT, isDefault: true },
  ];
  const fake = createFakePluginHost({
    pluginId: "bb--design-wiki",
    sdk: {
      projects: {
        list: async () => [
          { id: "p1", name: "Proj", sources },
          { id: "p2", name: "Bare", sources: [] },
        ],
        get: async ({ projectId }: { projectId: string }) => {
          if (options.failProject) throw new Error("Project not found");
          return {
            id: projectId,
            name: "Proj",
            sources: sources.map((source) => ({ type: "local_path", ...source })),
          };
        },
      },
      files: {
        listPaths: async ({ path }: { path: string }) => {
          if (options.listError) throw options.listError;
          const prefix = `${path}/`;
          const entries = Object.keys(files)
            .filter((file) => file.startsWith(prefix))
            .map((file) => ({
              kind: "file",
              path: file.slice(prefix.length),
              name: file.slice(file.lastIndexOf("/") + 1),
            }));
          return { paths: entries, truncated: false };
        },
        read: async ({ path }: { path: string }) => {
          const content = files[path];
          if (content === undefined) throw new Error("No such file");
          return {
            path,
            content,
            contentEncoding: "utf8",
            sizeBytes: content.length,
            sha256: "x",
          };
        },
      },
    },
  });
  await plugin(fake.bb);
  return fake;
}

describe("Design Wiki server", () => {
  it("lists projects and whether each has a checkout", async () => {
    const fake = await setup();
    expect(await fake.harness.callRpc("projects", {})).toEqual([
      { id: "p1", name: "Proj", hasCheckout: true },
      { id: "p2", name: "Bare", hasCheckout: false },
    ]);
  });

  it("lists pages read from the project's repository root", async () => {
    const fake = await setup({
      files: {
        [`${ROOT}/docs/wiki/src/cujs/boss.md`]: page("cuj-boss", "ruled", "ACME-1", "Boss"),
        [`${ROOT}/docs/wiki/src/cujs/bad.md`]: "no front matter",
      },
    });
    const list = wikiListSchema.parse(
      await fake.harness.callRpc("list", { projectId: "p1" }),
    );
    expect(list.state).toBe("ready");
    expect(list.pages.map((entry) => entry.id)).toEqual(["cuj-boss"]);
    expect(list.errors).toHaveLength(1);
  });

  it("reports an empty state when the project has no docs/wiki", async () => {
    const fake = await setup();
    const list = wikiListSchema.parse(
      await fake.harness.callRpc("list", { projectId: "p1" }),
    );
    expect(list.state).toBe("empty");
  });

  it("reports unavailable when the project has no checkout", async () => {
    const fake = await setup({ sources: [] });
    const list = wikiListSchema.parse(
      await fake.harness.callRpc("list", { projectId: "p1" }),
    );
    expect(list.state).toBe("unavailable");
  });

  it("reports unavailable when the project cannot be opened", async () => {
    const fake = await setup({ failProject: true });
    const list = wikiListSchema.parse(
      await fake.harness.callRpc("list", { projectId: "p1" }),
    );
    expect(list.state).toBe("unavailable");
    expect(list.message).toMatch(/not found/i);
  });

  it("shows an error row when the host fails to list a directory", async () => {
    const fake = await setup({ listError: new Error("host offline") });
    const list = wikiListSchema.parse(
      await fake.harness.callRpc("list", { projectId: "p1" }),
    );
    expect(list.state).toBe("ready");
    expect(list.errors[0]?.message).toMatch(/host offline/);
  });

  it("ignores nested files and non-Markdown files", async () => {
    const fake = await setup({
      files: {
        [`${ROOT}/docs/wiki/src/cujs/boss.md`]: page("cuj-boss", "ruled", "ACME-1", "Boss"),
        [`${ROOT}/docs/wiki/src/cujs/old/stale.md`]: "nested",
        [`${ROOT}/docs/wiki/src/cujs/notes.txt`]: "text",
      },
    });
    const list = wikiListSchema.parse(
      await fake.harness.callRpc("list", { projectId: "p1" }),
    );
    expect(list.pages.map((entry) => entry.id)).toEqual(["cuj-boss"]);
    expect(list.errors).toEqual([]);
  });

  it("returns one page with its body and claim markers", async () => {
    const fake = await setup({
      files: {
        [`${ROOT}/docs/wiki/src/cujs/boss.md`]: page("cuj-boss", "ruled", "ACME-1", "Boss"),
      },
    });
    const found = wikiPageResultSchema.parse(
      await fake.harness.callRpc("page", {
        projectId: "p1",
        pageId: "cuj-boss",
      }),
    );
    if (found.state !== "found") throw new Error("expected a page");
    expect(found.page.claims[0]).toMatchObject({ status: "ruled", cards: ["ACME-1"] });
    expect(await fake.harness.callRpc("page", { projectId: "p1", pageId: "cuj-nope" })).toEqual({
      state: "missing",
    });
  });
});
