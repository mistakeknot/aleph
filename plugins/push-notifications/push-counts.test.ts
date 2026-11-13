import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createPushCounts } from "./push-counts.js";

describe("push counts", () => {
  it("serializes increments and reads, separates threads, and survives store recreation", async () => {
    const host = createFakePluginHost({ pluginId: "push-notifications" });
    const store = createPushCounts(host.bb);
    const writes = Array.from({ length: 20 }, (_, index) =>
      store.record("thread-a", "question", 100 + index),
    );
    const read = store.get("thread-a");
    await Promise.all(writes);
    expect(await read).toEqual({
      question: 20,
      "turn-end": 0,
      error: 0,
      firstAt: 100,
      lastAt: 119,
    });
    await store.record("thread-b", "error", 200);
    await store.record("thread-a", "turn-end", 90);
    expect(await createPushCounts(host.bb).get("thread-a")).toEqual({
      question: 20,
      "turn-end": 1,
      error: 0,
      firstAt: 90,
      lastAt: 119,
    });
    expect(await store.get("thread-b")).toEqual({
      question: 0,
      "turn-end": 0,
      error: 1,
      firstAt: 200,
      lastAt: 200,
    });
    expect(await store.get("missing")).toEqual({
      question: 0,
      "turn-end": 0,
      error: 0,
      firstAt: null,
      lastAt: null,
    });
  });

  it("rejects malformed history without overwriting it or blocking later work", async () => {
    const host = createFakePluginHost({ pluginId: "push-notifications" });
    await host.bb.storage.kv.set("push-count:bad", { question: -1 });
    const store = createPushCounts(host.bb);
    await expect(store.record("bad", "error", 100)).rejects.toThrow();
    expect(await host.bb.storage.kv.get("push-count:bad")).toEqual({
      question: -1,
    });
    await store.record("good", "error", 100);
    expect((await store.get("good")).error).toBe(1);
  });
});
