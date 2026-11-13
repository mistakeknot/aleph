import { expect, it } from "vitest";
import { AnnotationStore } from "./annotation-store.js";

it("isolates host notes from the server and other hosts at the same port and URL", async () => {
  const values = new Map<string, unknown>();
  const keys: string[] = [];
  const store = new AnnotationStore({
    get: async <T>(key: string) => {
      keys.push(key);
      return values.get(key) as T | undefined;
    },
    set: async (key, value) => {
      values.set(key, value);
    },
  });
  const scope = { port: 3000, url: "https://preview.example/page" };
  await store.list(scope);
  await store.list({ ...scope, hostId: "host-a" });
  await store.list({ ...scope, hostId: "host-b" });
  expect(new Set(keys).size).toBe(3);
});

it("requires the declared host, port, and legacy origin even for authenticated calls", async () => {
  const { requireDeclaredAnnotationShare } =
    await import("./annotation-store.js");
  const share = {
    hostId: "host-a",
    port: 3000,
    url: "https://machine--3000.example.test/",
  };
  const scope = { ...share, url: share.url + "page?q=1#fragment" };
  expect(() => requireDeclaredAnnotationShare(scope, [share])).not.toThrow();
  for (const invalid of [
    { ...scope, hostId: "host-b" },
    { ...scope, port: 3001 },
    { ...scope, url: "https://other.example.test/page" },
  ])
    expect(() => requireDeclaredAnnotationShare(invalid, [share])).toThrow(
      "not shared",
    );
  expect(() => requireDeclaredAnnotationShare(scope, [])).toThrow("not shared");
  expect(() =>
    requireDeclaredAnnotationShare(scope, [
      { ...share, unavailableReason: "offline" },
    ]),
  ).toThrow("not shared");
});

it("persists and edits host notes without changing the same page on another host or server", async () => {
  const values = new Map<string, unknown>();
  const kv = {
    get: async <T>(key: string) => values.get(key) as T | undefined,
    set: async (key: string, value: unknown) => {
      values.set(key, structuredClone(value));
    },
  };
  const store = new AnnotationStore(kv);
  const scope = {
    hostId: "host-a",
    port: 3000,
    url: "https://preview.example/page",
  };
  const annotation = {
    id: "note",
    number: 1,
    comment: "Move this",
    url: scope.url,
    title: "Page",
    viewport: { width: 800, height: 600 },
    element: {
      tagName: "button",
      name: "Save",
      selector: "#save",
      text: "Save",
      attributes: {},
      styles: {},
      rect: { x: 1, y: 2, width: 30, height: 20 },
    },
  };
  await store.change(scope, { type: "annotation", annotation });
  await store.change(scope, {
    type: "annotation-update",
    id: "note",
    comment: "Updated",
  });
  expect((await new AnnotationStore(kv).list(scope))[0]?.comment).toBe(
    "Updated",
  );
  expect(await store.list({ ...scope, hostId: "host-b" })).toEqual([]);
  expect(await store.list({ port: scope.port, url: scope.url })).toEqual([]);
  expect(await store.list({ ...scope, url: scope.url + "?other" })).toEqual([]);
  await store.change(scope, { type: "annotation-delete", id: "note" });
  expect(await store.list(scope)).toEqual([]);
});
