import { expect, it } from "vitest";
import { AnnotationStore, annotationScopeSchema } from "./annotation-store.js";

it("rejects invalid page scopes", () => {
  expect(
    annotationScopeSchema.safeParse({ port: 3000, url: "javascript:alert(1)" })
      .success,
  ).toBe(false);
});

it("keeps additive storage isolated by share and page", async () => {
  const values = new Map<string, unknown>();
  const store = new AnnotationStore({
    get: async <T>(key: string) => values.get(key) as T | undefined,
    set: async (key, value) => {
      values.set(key, value);
    },
  });
  const scope = { port: 3000, url: "https://preview.example/page" };
  expect(await store.list(scope)).toEqual([]);
  await expect(
    store.change(scope, { type: "annotation-delete", id: "missing" }),
  ).rejects.toThrow("not found");
  expect(await store.list({ ...scope, port: 3001 })).toEqual([]);
});
