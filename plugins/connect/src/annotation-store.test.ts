import { expect, it, vi } from "vitest";
import { AnnotationStore, annotationScopeSchema } from "./annotation-store.js";

const note = (url: string, id = "note", attributes = {}) => ({
  type: "annotation" as const,
  annotation: {
    id,
    number: 1,
    comment: "Move",
    url,
    title: "Page",
    viewport: { width: 800, height: 600 },
    element: {
      tagName: "button",
      name: "Save",
      selector: "#save",
      text: "Save",
      attributes,
      styles: {},
      rect: { x: 0, y: 0, width: 10, height: 10 },
    },
  },
});
function memoryStore() {
  const values = new Map<string, unknown>();
  const kv = {
    get: async <T>(key: string) =>
      structuredClone(values.get(key)) as T | undefined,
    set: vi.fn(async (key: string, value: unknown) => {
      values.set(key, structuredClone(value));
    }),
  };
  return { values, kv, store: new AnnotationStore(kv) };
}

it("bounds arbitrary URLs, retains empty keys in the quota, and isolates host rate buckets", async () => {
  const { store, values } = memoryStore();
  vi.spyOn(Date, "now").mockReturnValue(100000);
  try {
    for (let i = 0; i < 60; i++) {
      const scope = { port: 3000, url: `https://preview.example.test/?n=${i}` };
      await store.change(scope, note(scope.url));
    }
    const scope = { port: 3000, url: "https://preview.example.test/?n=0" };
    await expect(
      store.change(scope, { type: "annotation-delete", id: "note" }),
    ).rejects.toThrow("rate");
    await store.change({ ...scope, hostId: "other" }, note(scope.url));
    vi.mocked(Date.now).mockReturnValue(200000);
    await store.change(scope, { type: "annotation-delete", id: "note" });
    await store.change(scope, note(scope.url));
    for (let i = 60; i < 64; i++) {
      const page = { ...scope, url: `https://preview.example.test/?n=${i}` };
      await store.change(page, note(page.url));
    }
    await store.change(scope, { type: "annotation-delete", id: "note" });
    const extra = { ...scope, url: "https://preview.example.test/?n=extra" };
    await expect(store.change(extra, note(extra.url))).rejects.toThrow("quota");
    expect(values.size).toBe(66);
  } finally {
    vi.restoreAllMocks();
  }
});

it("checks serialized page size and reserves quota before failed page writes", async () => {
  const { store, kv, values } = memoryStore();
  const scope = { port: 3000, url: "https://preview.example.test/" };
  const attributes = Object.fromEntries(
    Array.from({ length: 600 }, (_, i) => [String(i), "x".repeat(400)]),
  );
  await expect(
    store.change(scope, note(scope.url, "large", attributes)),
  ).rejects.toThrow("byte limit");
  expect(values.size).toBe(0);
  kv.set
    .mockImplementationOnce(async (key, value) => {
      values.set(key, structuredClone(value));
    })
    .mockRejectedValueOnce(new Error("disk"));
  await expect(store.change(scope, note(scope.url))).rejects.toThrow("disk");
  const index = values.get("annotations.index.v1") as {
    pages: Record<string, { bytes: number }>;
  };
  expect(Object.values(index.pages)[0]?.bytes).toBeGreaterThan(0);
  expect(values.size).toBe(1);
  await store.change(scope, note(scope.url));
  expect(await store.list(scope)).toHaveLength(1);
});

it("enforces aggregate share bytes and the global page budget", async () => {
  const { store } = memoryStore();
  const attributes = Object.fromEntries(
    Array.from({ length: 450 }, (_, i) => [String(i), "x".repeat(400)]),
  );
  for (let i = 0; i < 11; i++) {
    const scope = { port: 3000, url: `https://preview.example.test/${i}` };
    await store.change(scope, note(scope.url, "note", attributes));
  }
  const extra = { port: 3000, url: "https://preview.example.test/extra" };
  await expect(
    store.change(extra, note(extra.url, "note", attributes)),
  ).rejects.toThrow("storage quota");
  const global = memoryStore();
  for (let i = 0; i < 1024; i++) {
    const scope = { port: 3000 + i, url: "https://preview.example.test/" };
    try {
      await global.store.change(scope, note(scope.url));
    } catch (error) {
      expect(String(error)).toContain("index quota");
      break;
    }
  }
  const scope = { port: 6000, url: "https://preview.example.test/" };
  await expect(global.store.change(scope, note(scope.url))).rejects.toThrow(
    "quota",
  );
}, 30000);

it("rejects invalid page scopes", () => {
  expect(
    annotationScopeSchema.safeParse({ port: 3000, url: "javascript:alert(1)" })
      .success,
  ).toBe(false);
});

it("denies the global byte ceiling and keeps reservations when shrink commits fail", async () => {
  const { store, values, kv } = memoryStore();
  const scope = { port: 3000, url: "https://preview.example.test/" };
  values.set("annotations.index.v1", {
    pages: { reserved: { share: "other", bytes: 32 * 1024 * 1024 } },
    rates: {},
  });
  await expect(store.change(scope, note(scope.url))).rejects.toThrow(
    "storage quota",
  );
  values.clear();
  await store.change(scope, note(scope.url));
  const original = structuredClone(values.get("annotations.index.v1"));
  kv.set
    .mockImplementationOnce(async (key, value) => {
      values.set(key, structuredClone(value));
    })
    .mockImplementationOnce(async (key, value) => {
      values.set(key, structuredClone(value));
    })
    .mockRejectedValueOnce(new Error("index disk"));
  await expect(
    store.change(scope, { type: "annotation-delete", id: "note" }),
  ).rejects.toThrow("index disk");
  expect(await store.list(scope)).toEqual([]);
  expect(values.get("annotations.index.v1")).toMatchObject({
    pages: (original as { pages: unknown }).pages,
  });
  await store.change(scope, note(scope.url));
  expect(await store.list(scope)).toHaveLength(1);
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
