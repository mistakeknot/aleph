import { mkdtemp, readFile, rm, copyFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { setImmediate } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import {
  createFakePluginHost,
  type FakePluginHost,
} from "@get-bb/plugin-sdk/testing";
import plugin from "./server";
import { openStore } from "./store";
import * as stores from "./store";
import { parseRegistry } from "./registry";
import { sectionNameFor } from "./provision";

const fixture = new URL("./test/fixtures/registry-v4.json", import.meta.url);
const hosts: Array<{ host: FakePluginHost; apply: boolean }> = [];
const directories: string[] = [];
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function setup(mode?: "apply", configured = true) {
  const directory = await mkdtemp(join(tmpdir(), "layer-groups-"));
  directories.push(directory);
  const path = join(directory, "registry.json");
  await copyFile(fixture, path);
  const sections = new Map<string, { name: string; threads: string[] }>();
  let creates = 0;
  let listCalls = 0;
  let threadCalls = 0;
  const hooks: {
    create?: () => Promise<void>;
    list?: (call: number) => void | Promise<void>;
    threads?: (call: number) => void;
    allowDuplicateNames?: boolean;
  } = {};
  const forbidden = vi.fn(() => {
    throw new Error("Forbidden SDK write");
  });
  const host = createFakePluginHost({
    pluginId: "bb--layer-groups",
    settings: {
      ...(configured ? { registryPath: path } : {}),
      ...(mode ? { mode } : {}),
    },
    sdk: {
      threadSections: {
        list: async () => {
          const result = [...sections].map(([id, section]) => ({
            id,
            name: section.name,
          }));
          await hooks.list?.(++listCalls);
          return result;
        },
        create: vi.fn(async ({ name }) => {
          ++creates;
          await hooks.create?.();
          if (
            !hooks.allowDuplicateNames &&
            [...sections.values()].some((section) => section.name === name)
          )
            throw new Error("duplicate name");
          const id = `created-${creates}`;
          sections.set(id, { name, threads: [] });
          return { id, name };
        }),
        update: forbidden,
        delete: forbidden,
      },
      system: {
        uiPreferences: { set: forbidden, reset: forbidden },
        updateGeneralSettings: forbidden,
        updateKeyboardSettings: forbidden,
      },
      threads: {
        list: async (args) => {
          expect(args).toEqual({
            sectionId: expect.any(String),
            includeHidden: true,
            limit: 1,
          });
          const result = (sections.get(args!.sectionId!)?.threads ?? [])
            .slice(0, 1)
            .map((id) => ({ id }));
          hooks.threads?.(++threadCalls);
          return result;
        },
        update: forbidden,
        pin: forbidden,
        unpin: forbidden,
        reorderPinned: forbidden,
      },
    },
  });
  vi.spyOn(host.bb.storage.kv, "set");
  vi.spyOn(host.bb.storage.kv, "delete");
  hosts.push({ host, apply: mode === "apply" });
  const store = openStore(host.bb.storage.database(), host.bb.storage.migrate);
  return {
    ...host,
    sections,
    hooks,
    store,
    path,
    directory,
    creates: () => creates,
    start: async () => {
      await plugin(host.bb);
      expect(host.harness.registrations.cli).not.toBeNull();
    },
    provision: () => host.harness.runCli(["provision"]),
    owned: () => host.harness.callRpc("listOwnedSections", {}),
  };
}
afterEach(async () => {
  for (const { host, apply } of hosts.splice(0)) {
    expect(
      host.harness.sdk.calls.filter(
        (call) =>
          ![
            "threadSections.list",
            "threads.list",
            ...(apply ? ["threadSections.create"] : []),
          ].includes(call.path),
      ),
    ).toEqual([]);
    expect(host.bb.storage.kv.set).not.toHaveBeenCalled();
    expect(host.bb.storage.kv.delete).not.toHaveBeenCalled();
    await host.harness.lifecycle.dispose();
  }
  vi.restoreAllMocks();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
function report(result: { stdout: string }) {
  return JSON.parse(result.stdout);
}

it("defaults to preview and reports thirteen creates without SDK writes", async () => {
  const h = await setup();
  await h.start();
  const result = await h.provision();
  expect(result.exitCode).toBe(0);
  expect(report(result)).toMatchObject({
    mode: "preview",
    applied: false,
    actions: Array.from({ length: 13 }, () => ({ kind: "create" })),
  });
  expect(h.creates()).toBe(0);
});
it("applies ordered canonical layers and preserves renamed labels", async () => {
  const h = await setup("apply");
  await h.start();
  await h.provision();
  const snapshot = parseRegistry(await readFile(fixture), {
    sha256: "test",
    readAt: 1,
    commit: null,
    dirty: null,
  });
  expect(h.creates()).toBe(13);
  expect(await h.owned()).toEqual({
    stale: false,
    sections: snapshot.layers.map((layer, index) => ({
      sectionId: `created-${index + 1}`,
      layer: layer.key,
      letter: layer.letter,
      layerName: layer.name,
      sectionName: sectionNameFor(layer),
      accent: layer.accent,
      rank: layer.rank,
      order: layer.order,
    })),
  });
  h.sections.get("created-1")!.name = "Media stuff";
  expect(await h.owned()).toMatchObject({
    sections: [
      expect.objectContaining({
        sectionId: "created-1",
        sectionName: "Media stuff",
        layerName: snapshot.layers[0].name,
        accent: "#b9a5fc",
      }),
      ...snapshot.layers.slice(1).map(() => expect.anything()),
    ],
  });
  await h.provision();
  expect(h.creates()).toBe(13);
});
it("coalesces concurrent provisions", async () => {
  const h = await setup("apply");
  await h.start();
  const gate = deferred();
  const entered = deferred();
  h.hooks.create = async () => {
    entered.resolve();
    await gate.promise;
  };
  const first = h.provision();
  await entered.promise;
  const second = h.provision();
  gate.resolve();
  const results = await Promise.all([first, second]);
  expect(results[0]).toEqual(results[1]);
  expect(h.creates()).toBe(13);
  expect(h.store.exportAll().runs).toHaveLength(1);
});
it("reports unconfigured and unavailable without writes", async () => {
  const h = await setup(undefined, false);
  await h.start();
  expect(report(await h.harness.runCli(["status"]))).toMatchObject({
    kind: "unconfigured",
  });
  await h.provision();
  expect(h.harness.sdk.calls).toEqual([]);
  await h.harness.setSettings({ registryPath: join(h.directory, "absent") });
  expect(report(await h.provision())).toMatchObject({
    actions: [],
    errors: [expect.any(String)],
  });
  expect(report(await h.harness.runCli(["status"]))).toMatchObject({
    kind: "unavailable",
  });
});
it("omits missing and disabled sections and reenables a deleted layer once", async () => {
  const h = await setup("apply");
  await h.start();
  await h.provision();
  h.sections.delete("created-4");
  expect(await h.owned()).toMatchObject({
    sections: expect.not.arrayContaining([
      expect.objectContaining({ layer: "D" }),
    ]),
  });
  await h.provision();
  expect(h.creates()).toBe(13);
  expect((await h.harness.runCli(["enable-layer", "D"])).exitCode).toBe(0);
  await h.provision();
  expect(h.creates()).toBe(14);
  await h.provision();
  expect(h.creates()).toBe(14);
});
it("adopts an empty matching section and provisions the other twelve", async () => {
  const h = await setup("apply");
  h.sections.set("fashion", { name: "B · Fashion", threads: [] });
  await h.start();
  expect(report(await h.harness.runCli(["adopt", "B"]))).toEqual({
    kind: "adopted",
    layer: "B",
    sectionId: "fashion",
  });
  await h.provision();
  expect(h.creates()).toBe(12);
});
it.each(["not-empty", "renamed"] as const)(
  "rejects an adoption changed during verification: %s",
  async (reason) => {
    const h = await setup("apply");
    h.sections.set("fashion", { name: "B · Fashion", threads: [] });
    await h.start();
    if (reason === "not-empty")
      h.hooks.threads = (call) => {
        if (call === 1)
          h.sections.get("fashion")!.threads.push("hidden-archived");
      };
    else
      h.hooks.list = (call) => {
        if (call === 1) h.sections.get("fashion")!.name = "Fashion";
      };
    const result = await h.harness.runCli(["adopt", "B"]);
    expect(result.exitCode).not.toBe(0);
    expect(report(result)).toMatchObject({ kind: "conflict", reason });
    expect(h.store.layerSections()).toEqual([]);
    const next = report(await h.provision());
    if (reason === "not-empty") {
      expect(next.actions).toContainEqual(
        expect.objectContaining({
          kind: "needs-adopt",
          layer: "B",
          hasThreads: true,
        }),
      );
      expect(h.creates()).toBe(0);
    } else {
      expect(h.sections.get("fashion")!.name).toBe("Fashion");
      expect(
        [...h.sections.values()].filter((s) => s.name === "B · Fashion"),
      ).toHaveLength(1);
      expect(h.creates()).toBe(13);
    }
  },
);
it("recovers a populated pending adoption at startup", async () => {
  const h = await setup("apply");
  h.sections.set("fashion", {
    name: "B · Fashion",
    threads: ["hidden-archived"],
  });
  h.store.upsertLayerSection({
    layer: "B",
    sectionId: "fashion",
    state: "adopting",
    createdName: "B · Fashion",
    disabledReason: null,
    updatedAt: 1,
  });
  const sdk = h.bb.sdk;
  let listening = false;
  const access = vi.fn(() => {
    if (!listening) throw new Error("Server is not listening");
    return sdk;
  });
  Object.defineProperty(h.bb, "sdk", { configurable: true, get: access });
  await h.start();
  expect(access).not.toHaveBeenCalled();
  expect(h.store.layerSections()).toHaveLength(1);
  await expect(h.harness.runService("startup-recovery").done).rejects.toThrow(
    "Server is not listening",
  );
  listening = true;
  const service = h.harness.runService("startup-recovery");
  await h.harness.runCli(["export", join(h.directory, "recovered.json")]);
  expect(h.store.layerSections()).toEqual([]);
  const calls = h.harness.sdk.calls.length;
  await setImmediate();
  expect(h.harness.sdk.calls).toHaveLength(calls);
  service.controller.abort();
  await service.done;
  const restarted = h.harness.runService("startup-recovery");
  await setImmediate();
  expect(h.harness.sdk.calls).toHaveLength(calls);
  restarted.controller.abort();
  await restarted.done;
  expect(await h.owned()).toEqual({ stale: false, sections: [] });
  expect(report(await h.provision()).actions).toContainEqual(
    expect.objectContaining({
      kind: "needs-adopt",
      layer: "B",
      hasThreads: true,
    }),
  );
});
it("settles startup recovery cleanly when disposed during a section read", async () => {
  const h = await setup("apply");
  h.sections.set("fashion", { name: "B · Fashion", threads: [] });
  h.store.upsertLayerSection({
    layer: "B",
    sectionId: "fashion",
    state: "adopting",
    createdName: "B · Fashion",
    disabledReason: null,
    updatedAt: 1,
  });
  await h.start();
  const entered = deferred();
  const gate = deferred();
  h.hooks.list = async () => {
    entered.resolve();
    await gate.promise;
  };
  const service = h.harness.runService("startup-recovery");
  await entered.promise;
  const calls = h.harness.sdk.calls.length;
  const dispose = h.harness.lifecycle.dispose();
  gate.resolve();
  await Promise.all([service.done, dispose]);
  expect(h.harness.sdk.calls).toHaveLength(calls);
});
it.each([false, true])(
  "serializes adoption behind a provision and preserves unique owners (duplicate names: %s)",
  async (allowDuplicateNames) => {
    const h = await setup("apply");
    h.hooks.allowDuplicateNames = allowDuplicateNames;
    await h.start();
    const gate = deferred();
    const entered = deferred();
    const order: string[] = [];
    h.hooks.create = async () => {
      if (h.creates() === 1) {
        entered.resolve();
        await gate.promise;
      }
    };
    const run = h.provision().then((r) => {
      order.push("provision");
      return r;
    });
    await entered.promise;
    h.sections.set("fashion", { name: "B · Fashion", threads: [] });
    const reads = h.harness.sdk.calls.filter((call) =>
      ["threadSections.list", "threads.list"].includes(call.path),
    );
    const adoption = h.harness.runCli(["adopt", "B"]).then((r) => {
      order.push("adopt");
      return r;
    });
    try {
      for (let i = 0; i < 20; i++) await setImmediate();
      expect(order).toEqual([]);
      expect(
        h.harness.sdk.calls.filter((call) =>
          ["threadSections.list", "threads.list"].includes(call.path),
        ),
      ).toEqual(reads);
    } finally {
      gate.resolve();
      await run;
    }
    expect(report(await adoption)).toMatchObject(
      allowDuplicateNames
        ? { kind: "already-owned", layer: "B" }
        : { kind: "adopted", layer: "B", sectionId: "fashion" },
    );
    expect(order).toEqual(["provision", "adopt"]);
    const rows = h.store.layerSections();
    expect(rows.find((row) => row.layer === "B")?.sectionId).toBe(
      allowDuplicateNames ? "created-2" : "fashion",
    );
    expect(new Set(rows.map((r) => r.sectionId)).size).toBe(rows.length);
  },
);
it("rejects relative export paths without writing a file", async () => {
  const h = await setup();
  await h.start();
  const path = join(h.directory, "relative-export.json");
  const result = await h.harness.runCli([
    "export",
    relative(process.cwd(), path),
  ]);
  expect(result.exitCode).not.toBe(0);
  expect(`${result.stdout}${result.stderr ?? ""}`).toMatch(/absolute path/i);
  await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
});

it("exports five keys and schedules a run", async () => {
  const h = await setup();
  await h.start();
  await h.harness.runSchedule("provision");
  expect(h.store.exportAll().runs).toHaveLength(1);
  const path = join(h.directory, "export.json");
  expect((await h.harness.runCli(["export", path])).exitCode).toBe(0);
  expect(Object.keys(JSON.parse(await readFile(path, "utf8"))).sort()).toEqual([
    "assignments",
    "layerSections",
    "overrides",
    "runs",
    "snapshot",
  ]);
  expect(report(await h.harness.runCli(["status"]))).toMatchObject({
    kind: "unchanged",
    sha256: expect.any(String),
    ageMs: expect.any(Number),
    lastRun: h.store.lastRun(),
  });
});
it.each(["preview", "apply"] as const)(
  "uses stale snapshots only in preview: %s",
  async (mode) => {
    const h = await setup();
    await h.start();
    await h.provision();
    await unlink(h.path);
    await h.harness.setSettings({ mode });
    const result = report(await h.provision());
    expect(result.actions).toHaveLength(mode === "preview" ? 13 : 0);
    expect(result.errors).not.toHaveLength(0);
    expect(await h.owned()).toEqual({ stale: true, sections: [] });
    expect(h.creates()).toBe(0);
  },
);
it("drains dispose after persisting the in-flight create and stops further calls", async () => {
  const h = await setup("apply");
  const originalOpen = stores.openStore;
  let pluginStore = h.store;
  vi.spyOn(stores, "openStore").mockImplementation((...args) => {
    pluginStore = originalOpen(...args);
    return pluginStore;
  });
  await h.start();
  const gate = deferred();
  const entered = deferred();
  const order: string[] = [];
  h.hooks.create = async () => {
    entered.resolve();
    await gate.promise;
  };
  const run = h.provision().then(() => {
    order.push("run");
  });
  await entered.promise;
  const upsert = pluginStore.upsertLayerSection.bind(pluginStore);
  let persisted = false;
  vi.spyOn(pluginStore, "upsertLayerSection").mockImplementation((row) => {
    upsert(row);
    persisted = pluginStore
      .layerSections()
      .some((stored) => stored.sectionId === row.sectionId);
  });
  const calls = h.harness.sdk.calls.length;
  const dispose = h.harness.lifecycle.dispose().then(() => {
    expect(persisted).toBe(true);
    order.push("dispose");
  });
  gate.resolve();
  await Promise.all([run, dispose]);
  expect(order).toEqual(["run", "dispose"]);
  expect(h.creates()).toBe(1);
  expect(h.harness.sdk.calls).toHaveLength(calls);
  try {
    await h.harness.runSchedule("provision");
  } catch (error) {
    expect(error).toHaveProperty("name", "PluginContextStaleError");
  }
  expect(h.harness.sdk.calls).toHaveLength(calls);
});
it("hides adopting and disabled rows and recovers pending rows before each run", async () => {
  const h = await setup();
  await h.start();
  await h.provision();
  for (const [layer, state] of [
    ["A", "adopting"],
    ["B", "disabled"],
  ] as const) {
    const name = layer === "A" ? "A · Media" : "B · Fashion";
    h.sections.set(layer, { name, threads: [] });
    h.store.upsertLayerSection({
      layer,
      sectionId: layer,
      state,
      createdName: name,
      disabledReason: null,
      updatedAt: 1,
    });
  }
  expect(await h.owned()).toEqual({ stale: false, sections: [] });
  await h.provision();
  expect(await h.owned()).toMatchObject({
    sections: [expect.objectContaining({ layer: "A", sectionId: "A" })],
  });
  expect(h.store.layerSections().find((row) => row.layer === "A")?.state).toBe(
    "active",
  );
});
it("maps GSV to Studio when reenabling and adopting", async () => {
  const h = await setup("apply");
  await h.start();
  await h.provision();
  h.sections.delete("created-13");
  await h.provision();
  expect(
    h.store.layerSections().find((row) => row.layer === "STUDIO")?.state,
  ).toBe("disabled");
  expect(report(await h.harness.runCli(["enable-layer", "GSV"]))).toEqual({
    enabled: true,
  });
  h.sections.set("studio", { name: "GSV · Studio", threads: [] });
  expect(report(await h.harness.runCli(["adopt", "GSV"]))).toEqual({
    kind: "adopted",
    layer: "STUDIO",
    sectionId: "studio",
  });
  await h.provision();
  expect(h.creates()).toBe(13);
});
