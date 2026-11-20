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
  truncatedList?: boolean;
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
          return { paths: entries, truncated: options.truncatedList === true };
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

  it("shows an error row instead of a partial list when the host listing is truncated", async () => {
    const fake = await setup({
      truncatedList: true,
      files: {
        [`${ROOT}/docs/wiki/src/cujs/boss.md`]: page("cuj-boss", "ruled", "ACME-1", "Boss"),
      },
    });
    const list = wikiListSchema.parse(
      await fake.harness.callRpc("list", { projectId: "p1" }),
    );
    expect(list.state).toBe("ready");
    expect(list.pages).toEqual([]);
    expect(list.errors.map((error) => error.message).join(" ")).toMatch(
      /incomplete/,
    );
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

function nativeSpec(actor = "Reader") {
  return JSON.stringify({
    cuj_id: "sample-read-page",
    version: "1.0",
    actor,
    trigger: "Open",
    steps: [{ step: "Read" }],
    mental_model: "Mine",
    success_condition: "Recognized",
  });
}

async function nativeBoundary(
  options: {
    names?: string[];
    truncated?: boolean;
    error?: Error;
    bytes?: number;
  } = {},
) {
  const reads: { path: string; rootPath?: string }[] = [];
  const listings: {
    path: string;
    limit?: number;
    includeHidden?: boolean;
    includeDirectories: boolean;
  }[] = [];
  const fake = createFakePluginHost({
    pluginId: "bb--design-wiki",
    sdk: {
      projects: {
        get: async () => ({
          id: "p1",
          name: "Proj",
          sources: [
            {
              type: "local_path",
              hostId: "host-1",
              path: ROOT,
              isDefault: true,
            },
          ],
        }),
      },
      files: {
        listPaths: async (input: (typeof listings)[number]) => {
          listings.push(input);
          if (!input.path.endsWith("/docs/cujs"))
            return { paths: [], truncated: false };
          if (options.error) throw options.error;
          return {
            paths: (
              options.names ?? [
                "nested/spec.json",
                "nested/spec.md",
                "notes.txt",
              ]
            ).map((path) => ({
              kind: "file",
              path,
              name: path.split("/").at(-1),
            })),
            truncated: options.truncated ?? false,
          };
        },
        read: async (input: (typeof reads)[number]) => {
          reads.push(input);
          return {
            path: input.path,
            content: nativeSpec(),
            contentEncoding: "utf8",
            sizeBytes: options.bytes ?? nativeSpec().length,
            sha256: "x",
          };
        },
      },
    },
  });
  await plugin(fake.bb);
  return { fake, reads, listings };
}

describe("native spec SDK boundary", () => {
  it("reads nested JSON only, bounds the listing, and roots reads in the checkout", async () => {
    const { fake, reads, listings } = await nativeBoundary();
    const result = wikiListSchema.parse(
      await fake.harness.callRpc("list", { projectId: "p1" }),
    );
    expect(result.pages.map((page) => page.id)).toEqual([
      "cujgel:sample-read-page",
    ]);
    expect(reads).toEqual([
      {
        path: `${ROOT}/docs/cujs/nested/spec.json`,
        rootPath: ROOT,
        hostId: "host-1",
      },
    ]);
    expect(
      listings.find((input) => input.path.endsWith("/docs/cujs")),
    ).toMatchObject({
      limit: 10000,
      includeHidden: false,
      includeDirectories: true,
    });
  });
  it("accepts absolute host result paths", async () => {
    const { fake } = await nativeBoundary({
      names: [`${ROOT}/docs/cujs/spec.json`],
    });
    expect(
      wikiListSchema.parse(
        await fake.harness.callRpc("list", { projectId: "p1" }),
      ).pages,
    ).toHaveLength(1);
  });
  it.each([
    { truncated: true, message: "incomplete" },
    {
      names: [Array(14).fill("nested").join("/") + "/spec.json"],
      message: "depth",
    },
    { names: ["../escape.json"], message: "Unsafe" },
    { bytes: 512 * 1024 + 1, message: "larger than 512 KB" },
  ])(
    "rejects bounded or unsafe discovery: $message",
    async ({ message, ...options }) => {
      const { fake } = await nativeBoundary(options);
      const result = wikiListSchema.parse(
        await fake.harness.callRpc("list", { projectId: "p1" }),
      );
      expect(result.pages).toEqual([]);
      expect(
        result.errors.some((error) => error.message.includes(message)),
      ).toBe(true);
    },
  );
  it("rejects an over-limit entry count even if the host omits truncation", async () => {
    const { fake, reads } = await nativeBoundary({
      names: Array.from({ length: 10001 }, (_, index) => `${index}.json`),
    });
    const result = wikiListSchema.parse(
      await fake.harness.callRpc("list", { projectId: "p1" }),
    );
    expect(result.pages).toEqual([]);
    expect(
      result.errors.some((error) => error.message.includes("incomplete")),
    ).toBe(true);
    expect(reads).toEqual([]);
  });
  it("distinguishes a missing native directory from host failure", async () => {
    const missing = await nativeBoundary({
      error: Object.assign(new Error("ENOENT: no such file or directory"), {
        code: "ENOENT",
      }),
    });
    const failed = await nativeBoundary({
      error: new Error("host unavailable"),
    });
    const absent = wikiListSchema.parse(
      await missing.fake.harness.callRpc("list", { projectId: "p1" }),
    );
    const error = wikiListSchema.parse(
      await failed.fake.harness.callRpc("list", { projectId: "p1" }),
    );
    expect(absent.state).toBe("empty");
    expect(absent.errors).toEqual([]);
    expect(absent.message).toContain("docs/cujs");
    expect(error.errors).toEqual([
      expect.objectContaining({
        path: "docs/cujs",
        message: "host unavailable",
      }),
    ]);
  });
  it("keeps authored ruled pages beside native specs and ignores companions", async () => {
    const fake = await setup({
      files: {
        [`${ROOT}/docs/wiki/src/cujs/legacy.md`]: page(
          "cuj-legacy",
          "ruled",
          "DEMO-1",
          "Legacy",
        ),
        [`${ROOT}/docs/cujs/spec.json`]: nativeSpec(),
        [`${ROOT}/docs/cujs/spec.md`]: "Companion narrative",
      },
    });
    const result = wikiListSchema.parse(
      await fake.harness.callRpc("list", { projectId: "p1" }),
    );
    expect(result.pages.map((page) => [page.id, page.status])).toEqual([
      ["cuj-legacy", "ruled"],
      ["cujgel:sample-read-page", null],
    ]);
    expect(result.errors).toEqual([]);
  });
});

it("accepts the native depth and byte limits without off-by-one rejection", async () => {
  const { fake } = await nativeBoundary({
    names: [`${Array(12).fill("nested").join("/")}/spec.json`],
    bytes: 512 * 1024,
  });
  const result = wikiListSchema.parse(
    await fake.harness.callRpc("list", { projectId: "p1" }),
  );
  expect(result.pages).toHaveLength(1);
  expect(result.errors).toEqual([]);
});
