import { expect, it } from "vitest";
import { discoverWiki } from "./wiki-discovery.js";
const spec = JSON.stringify({
  cuj_id: "sample-read-page",
  version: "1.0",
  actor: "Reader",
  trigger: "Open",
  steps: [{ step: "Read" }],
  mental_model: "Mine",
  success_condition: "Recognized",
});
it("discovers nested JSON and excludes every duplicate identity", async () => {
  const result = await discoverWiki({
    listMarkdownFiles: async () => null,
    listJsonFiles: async () => ["nested/a.json", "b.json"],
    readText: async () => spec,
  });
  expect(result.pages).toEqual([]);
  expect(result.list.errors).toHaveLength(2);
  expect(
    result.list.errors.every(
      (error) => error.pageId === "cujgel:sample-read-page",
    ),
  ).toBe(true);
});
it("discovers a native spec without companion Markdown", async () => {
  const result = await discoverWiki({
    listMarkdownFiles: async () => null,
    listJsonFiles: async () => ["nested/a.json"],
    readText: async () => spec,
  });
  expect(result.pages[0]?.path).toBe("docs/cujs/nested/a.json");
});
