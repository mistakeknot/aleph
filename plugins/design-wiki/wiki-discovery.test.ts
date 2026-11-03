import { describe, expect, it } from "vitest";
import { discoverWiki, type WikiFileSource } from "./wiki-discovery.js";

function page(id: string, title: string, status = "open"): string {
  return `---\nid: ${id}\nstatus: ${status}\ncard: ""\nsource: docs/${id}.md\nupdated: 2026-11-03\n---\n\n# ${title}\n\nBody.\n`;
}

function sourceOf(
  files: Record<string, string>,
  options: { missing?: string[]; failList?: string[] } = {},
): WikiFileSource {
  return {
    async listMarkdownFiles(directory) {
      if (options.failList?.includes(directory)) throw new Error("denied");
      if (options.missing?.includes(directory)) return null;
      const prefix = `${directory}/`;
      const names = Object.keys(files)
        .filter((path) => path.startsWith(prefix))
        .map((path) => path.slice(prefix.length));
      return names.length === 0 && !(directory in { ...files }) ? [] : names;
    },
    async readText(path) {
      const content = files[path];
      if (content === undefined) throw new Error(`no such file: ${path}`);
      return content;
    },
  };
}

describe("discoverWiki", () => {
  it("reports an empty state when docs/wiki does not exist", async () => {
    const result = await discoverWiki(
      sourceOf(
        {},
        {
          missing: ["docs/wiki/src/cujs", "docs/wiki/src/requirements"],
        },
      ),
    );
    expect(result.list.state).toBe("empty");
    expect(result.list.message).toMatch(/no docs\/wiki/i);
    expect(result.list.pages).toEqual([]);
    expect(result.pages).toEqual([]);
  });

  it("reports an empty state when the directories hold no pages", async () => {
    const result = await discoverWiki(sourceOf({}));
    expect(result.list.state).toBe("empty");
    expect(result.list.message).toMatch(/no CUJ or requirement pages/i);
  });

  it("lists CUJs before requirements, sorted by id", async () => {
    const result = await discoverWiki(
      sourceOf({
        "docs/wiki/src/requirements/b.md": page("req-b", "B"),
        "docs/wiki/src/cujs/z.md": page("cuj-z", "Z"),
        "docs/wiki/src/cujs/a.md": page("cuj-a", "A"),
      }),
    );
    expect(result.list.state).toBe("ready");
    expect(result.list.pages.map((entry) => entry.id)).toEqual([
      "cuj-a",
      "cuj-z",
      "req-b",
    ]);
    expect(result.list.pages[0]).not.toHaveProperty("body");
    expect(result.pages[0]?.body).toContain("Body.");
  });

  it("turns a malformed page into an error row without dropping the others", async () => {
    const result = await discoverWiki(
      sourceOf({
        "docs/wiki/src/cujs/ok.md": page("cuj-ok", "Okay"),
        "docs/wiki/src/cujs/bad.md": "# no front matter\n",
      }),
    );
    expect(result.list.pages.map((entry) => entry.id)).toEqual(["cuj-ok"]);
    expect(result.list.errors).toHaveLength(1);
    expect(result.list.errors[0]).toMatchObject({
      kind: "cuj",
      path: "docs/wiki/src/cujs/bad.md",
    });
  });

  it("flags a duplicate page id", async () => {
    const result = await discoverWiki(
      sourceOf({
        "docs/wiki/src/cujs/a.md": page("cuj-a", "First"),
        "docs/wiki/src/cujs/b.md": page("cuj-a", "Second"),
      }),
    );
    expect(result.list.pages).toHaveLength(1);
    expect(result.list.errors[0]?.message).toMatch(/duplicate/i);
  });

  it("reports a directory that cannot be listed as an error row", async () => {
    const result = await discoverWiki(
      sourceOf(
        { "docs/wiki/src/cujs/a.md": page("cuj-a", "A") },
        { failList: ["docs/wiki/src/requirements"] },
      ),
    );
    expect(result.list.pages).toHaveLength(1);
    expect(result.list.errors[0]).toMatchObject({
      kind: "requirement",
      path: "docs/wiki/src/requirements",
    });
  });

  it("reports an unreadable page as an error row", async () => {
    const source = sourceOf({ "docs/wiki/src/cujs/a.md": page("cuj-a", "A") });
    const result = await discoverWiki({
      ...source,
      async readText() {
        throw new Error("permission denied");
      },
    });
    expect(result.list.errors[0]?.message).toMatch(/permission denied/);
  });
});
