import Database from "better-sqlite3";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { parseRegistry } from "./registry";
import { openStore, type LayerSectionRow } from "./store";
import {
  adoptSection,
  applyProvision,
  planProvision,
  recoverAdoptions,
  sectionNameFor,
  type SectionsPort,
} from "./provision";

const snapshot = parseRegistry(
  readFileSync(new URL("./test/fixtures/registry-v4.json", import.meta.url)),
  { sha256: "fixture", readAt: 10, commit: null, dirty: null },
);
const b = snapshot.layers.find((layer) => layer.key === "B")!;
const adopting: LayerSectionRow = {
  layer: "B",
  sectionId: "fashion",
  state: "adopting",
  createdName: "B · Fashion",
  disabledReason: null,
  updatedAt: 10,
};
const databases: Database.Database[] = [];
const directories: string[] = [];
afterEach(() => {
  databases.splice(0).forEach((db) => {
    if (db.open) db.close();
  });
  directories
    .splice(0)
    .forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

class Sections implements SectionsPort {
  sections = new Map<string, { name: string; threads: string[] }>();
  creates: string[] = [];
  listCalls = 0;
  threadCalls = 0;
  onList?: (call: number) => void;
  onThreads?: (call: number) => void;
  onCreate?: (call: number) => void;
  async list() {
    const result = [...this.sections].map(([id, { name }]) => ({ id, name }));
    this.onList?.(++this.listCalls);
    return result;
  }
  async hasThreads(id: string) {
    const result = (this.sections.get(id)?.threads.length ?? 0) > 0;
    this.onThreads?.(++this.threadCalls);
    return result;
  }
  async create(name: string) {
    this.creates.push(name);
    this.onCreate?.(this.creates.length);
    if ([...this.sections.values()].some((section) => section.name === name))
      throw new Error("duplicate name");
    const id = `created-${this.creates.length}`;
    this.sections.set(id, { name, threads: [] });
    return { id, name };
  }
}

function setup(path = ":memory:") {
  const db = new Database(path);
  databases.push(db);
  const store = openStore(db, (database, statements) => {
    const version = database.pragma("user_version", { simple: true });
    if (typeof version !== "number")
      throw new Error("Invalid migration version");
    database.transaction(() => {
      for (const statement of statements.slice(version))
        database.exec(statement);
      database.pragma(`user_version = ${statements.length}`);
    })();
  });
  const port = new Sections();
  const plan = () =>
    planProvision({ snapshot, rows: store.layerSections(), port });
  const run = async (mode: "preview" | "apply" = "apply") =>
    applyProvision({ mode, actions: await plan(), store, port, now: 20 });
  return { db, store, port, plan, run };
}

it.each([
  ["A", "A · Media"],
  ["C", "C · Cognition"],
  ["K", "K · Deep-substrate"],
  ["X", "X · Infrastructure-of-the-lab"],
  ["STUDIO", "GSV · Studio"],
])("names %s from its first trimmed name segment", (key, name) => {
  const layer = snapshot.layers.find((layer) => layer.key === key)!;
  expect(sectionNameFor(layer)).toBe(name);
  expect(
    sectionNameFor({
      ...layer,
      name: ` ${layer.name.split(" / ")[0]}  / other`,
    }),
  ).toBe(name);
});

it("previews all 13 creates in snapshot order without writing sections or ownership", async () => {
  const { store, port, plan, run } = setup();
  const actions = await plan();
  expect(actions).toEqual(
    snapshot.layers.map((layer) => ({
      kind: "create",
      layer: layer.key,
      name: sectionNameFor(layer),
    })),
  );
  expect(await run("preview")).toEqual({
    mode: "preview",
    applied: false,
    actions,
    errors: [],
  });
  expect(port.creates).toEqual([]);
  expect(store.layerSections()).toEqual([]);
  expect(store.exportAll().runs).toHaveLength(1);
});

it("creates once, keeps current names, and disables deleted sections until explicit re-enable", async () => {
  const { store, port, plan, run } = setup();
  expect((await run()).applied).toBe(true);
  expect(port.creates).toHaveLength(13);
  expect(store.layerSections()).toHaveLength(13);
  expect(store.layerSections().every((row) => row.state === "active")).toBe(
    true,
  );
  expect((await plan()).every((action) => action.kind === "keep")).toBe(true);
  const a = store.layerSections().find((row) => row.layer === "A")!;
  port.sections.get(a.sectionId)!.name = "Media stuff";
  expect(await plan()).toContainEqual({
    kind: "keep",
    layer: "A",
    sectionId: a.sectionId,
    label: "Media stuff",
  });
  const d = store.layerSections().find((row) => row.layer === "D")!;
  port.sections.delete(d.sectionId);
  expect(await plan()).toContainEqual({
    kind: "disable",
    layer: "D",
    sectionId: d.sectionId,
    reason: "section-deleted",
  });
  await run();
  expect(store.layerSections()).toContainEqual({
    ...d,
    state: "disabled",
    disabledReason: "section-deleted",
    updatedAt: 20,
  });
  expect(await plan()).toContainEqual({ kind: "skip-disabled", layer: "D" });
  expect(port.creates).toHaveLength(13);
  expect(store.reenableLayer("D", 30)).toBe(true);
  expect(store.layerSections().some((row) => row.layer === "D")).toBe(false);
  expect(store.exportAll().runs).toContainEqual(
    expect.objectContaining({ kind: "enable-layer" }),
  );
  await run();
  expect(port.creates.slice(13)).toEqual(["D · Commerce"]);
  await run();
  expect(port.creates).toHaveLength(14);
  expect(await plan()).toContainEqual(
    expect.objectContaining({ kind: "keep", layer: "D" }),
  );
});

it.each([false, true])(
  "never adopts automatically, even if hasThreads is %s",
  async (hasThreads) => {
    const { store, port, run } = setup();
    port.sections.set("fashion", {
      name: "B · Fashion",
      threads: hasThreads ? ["thread-1"] : [],
    });
    const report = await run();
    expect(report.applied).toBe(false);
    expect(report.actions).toContainEqual({
      kind: "needs-adopt",
      layer: "B",
      sectionId: "fashion",
      name: "B · Fashion",
      hasThreads,
    });
    expect(port.creates).toEqual([]);
    expect(store.layerSections()).toEqual([]);
    expect(store.exportAll().runs).toHaveLength(1);
  },
);

it("keeps adoption pending until verification, then promotes and keeps it", async () => {
  const { store, port, plan } = setup();
  port.sections.set("fashion", { name: "B · Fashion", threads: [] });
  let pendingPlan: ReturnType<typeof plan> | undefined;
  port.onThreads = (call) => {
    if (call === 2) {
      expect(store.layerSections()).toEqual([adopting]);
      pendingPlan = plan();
    }
  };
  expect(await adoptSection({ layer: b, store, port, now: 10 })).toEqual({
    kind: "adopted",
    layer: "B",
    sectionId: "fashion",
  });
  expect(await pendingPlan).toContainEqual({
    kind: "adopt-pending",
    layer: "B",
    sectionId: "fashion",
  });
  expect(
    (await pendingPlan)?.filter((action) => action.kind === "create"),
  ).toHaveLength(12);
  expect(store.layerSections()).toEqual([{ ...adopting, state: "active" }]);
  expect(await plan()).toContainEqual({
    kind: "keep",
    layer: "B",
    sectionId: "fashion",
    label: "B · Fashion",
  });
  expect(
    (await plan()).filter((action) => action.kind === "create"),
  ).toHaveLength(12);
});

it.each(["not-empty", "renamed", "gone"] as const)(
  "compensates an adoption racing with %s and provisions safely afterwards",
  async (reason) => {
    const { store, port, plan, run } = setup();
    const section = { name: "B · Fashion", threads: [] as string[] };
    port.sections.set("fashion", section);
    if (reason === "not-empty")
      port.onThreads = (call) => {
        if (call === 1) section.threads.push("thread-1");
      };
    else
      port.onList = (call) => {
        if (call !== 1) return;
        if (reason === "renamed") section.name = "Fashion";
        else port.sections.delete("fashion");
      };
    expect(await adoptSection({ layer: b, store, port, now: 10 })).toEqual({
      kind: "conflict",
      layer: "B",
      sectionId: "fashion",
      reason,
    });
    expect(store.layerSections()).toEqual([]);
    if (reason === "not-empty") {
      expect(await plan()).toContainEqual({
        kind: "needs-adopt",
        layer: "B",
        sectionId: "fashion",
        name: "B · Fashion",
        hasThreads: true,
      });
      await run();
      expect(port.creates).toEqual([]);
    } else {
      await run();
      expect(
        port.creates.filter((name) => name === "B · Fashion"),
      ).toHaveLength(1);
      expect(store.layerSections()).toContainEqual(
        expect.objectContaining({ layer: "B", state: "active" }),
      );
      if (reason === "renamed")
        expect(port.sections.get("fashion")).toEqual({
          name: "Fashion",
          threads: [],
        });
    }
  },
);

it("refuses nonempty sections before writing and reports missing or already-owned layers", async () => {
  const { store, port } = setup();
  const args = { layer: b, store, port, now: 10 };
  expect(await adoptSection(args)).toEqual({ kind: "not-found", layer: "B" });
  port.sections.set("fashion", { name: "B · Fashion", threads: ["thread-1"] });
  expect(await adoptSection(args)).toEqual({
    kind: "conflict",
    layer: "B",
    sectionId: "fashion",
    reason: "not-empty",
  });
  expect(store.layerSections()).toEqual([]);
  store.upsertLayerSection(adopting);
  expect(await adoptSection(args)).toEqual({
    kind: "already-owned",
    layer: "B",
  });
});

it.each([false, true])(
  "recovers durable adopting rows after a crash with hasThreads=%s",
  async (hasThreads) => {
    const dir = mkdtempSync(join(tmpdir(), "layer-groups-test-"));
    directories.push(dir);
    const path = join(dir, "store.sqlite");
    const first = setup(path);
    first.store.upsertLayerSection(adopting);
    first.db.close();
    const { store, port, plan } = setup(path);
    port.sections.set("fashion", {
      name: "B · Fashion",
      threads: hasThreads ? ["thread-1"] : [],
    });
    expect(await recoverAdoptions({ store, port, now: 30 })).toEqual([
      hasThreads
        ? { layer: "B", outcome: "removed", reason: "not-empty" }
        : { layer: "B", outcome: "promoted" },
    ]);
    expect(store.layerSections()).toEqual(
      hasThreads ? [] : [{ ...adopting, state: "active", updatedAt: 30 }],
    );
    expect(await plan()).toContainEqual(
      hasThreads
        ? {
            kind: "needs-adopt",
            layer: "B",
            sectionId: "fashion",
            name: "B · Fashion",
            hasThreads: true,
          }
        : {
            kind: "keep",
            layer: "B",
            sectionId: "fashion",
            label: "B · Fashion",
          },
    );
  },
);

it.each(["renamed", "gone"] as const)(
  "removes crashed adoptions whose section is %s without touching active rows",
  async (reason) => {
    const { store, port } = setup();
    store.upsertLayerSection(adopting);
    store.upsertLayerSection({
      ...adopting,
      layer: "A",
      sectionId: "media",
      state: "active",
    });
    if (reason === "renamed")
      port.sections.set("fashion", { name: "Fashion", threads: [] });
    expect(await recoverAdoptions({ store, port, now: 30 })).toEqual([
      { layer: "B", outcome: "removed", reason },
    ]);
    expect(store.layerSections()).toEqual([
      expect.objectContaining({ layer: "A", state: "active" }),
    ]);
  },
);

it("stops after abort while persisting the section already created", async () => {
  const { store, port, plan } = setup();
  const signal = { aborted: false };
  port.onCreate = () => {
    signal.aborted = true;
  };
  await applyProvision({
    mode: "apply",
    actions: await plan(),
    store,
    port,
    now: 20,
    signal,
  });
  expect(port.creates).toHaveLength(1);
  expect(store.layerSections()).toEqual([
    expect.objectContaining({ layer: snapshot.layers[0].key, state: "active" }),
  ]);
  expect(store.exportAll().runs).toHaveLength(1);
});

it("issues no create when already aborted", async () => {
  const { store, port, plan } = setup();
  expect(
    (
      await applyProvision({
        mode: "apply",
        actions: await plan(),
        store,
        port,
        now: 20,
        signal: { aborted: true },
      })
    ).applied,
  ).toBe(false);
  expect(port.creates).toEqual([]);
});

it("records create errors and retains prior successful sections for the next plan", async () => {
  const { store, port, plan, run } = setup();
  port.onCreate = (call) => {
    if (call === 2) throw new Error("create failed");
  };
  const report = await run();
  expect(report.errors).toEqual(["create failed"]);
  expect(report.applied).toBe(false);
  expect(port.creates).toHaveLength(2);
  expect(store.layerSections()).toHaveLength(1);
  expect(await plan()).toContainEqual(
    expect.objectContaining({ kind: "keep", layer: snapshot.layers[0].key }),
  );
  expect(store.exportAll().runs).toHaveLength(1);
});
