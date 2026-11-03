import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { PIN_MIGRATIONS } from "./pin-migrations.js";
import plugin from "./server.js";

const ROOT = "/work/proj";
const CUJ = `${ROOT}/docs/wiki/src/cujs/boss.md`;

function pageText(body: string): string {
  return `---\nid: cuj-boss\nstatus: open\ncard: ""\nsource: docs/x.md\nupdated: 2026-11-03\n---\n\n# Boss\n\n${body}\n`;
}

const BODY = [
  "**Open: first question**",
  "text",
  "**Ruled — ACME-1:** second",
].join("\n");

const FIRST = {
  label: "Open: first question",
  context: "**Open: first question**",
  ordinal: 0,
  groupSize: 1,
};

interface SetupOptions {
  files?: Record<string, string>;
  threads?: Record<string, { id: string; projectId: string }>;
  sources?: { hostId: string; path: string; isDefault: boolean }[];
}

function buildHost(state: {
  files: Record<string, string>;
  threads: Record<string, { id: string; projectId: string }>;
  sources: { hostId: string; path: string; isDefault: boolean }[];
}) {
  const writes: string[] = [];
  const forbidden = (name: string) => async () => {
    writes.push(name);
    throw new Error(`design wiki must not call files.${name}`);
  };
  return {
    writes,
    host: createFakePluginHost({
      pluginId: "bb--design-wiki",
      sdk: {
        projects: {
          list: async () => [
            { id: "p1", name: "Proj", sources: state.sources },
            { id: "p2", name: "Other", sources: state.sources },
          ],
          get: async ({ projectId }: { projectId: string }) => ({
            id: projectId,
            name: "Proj",
            sources: state.sources.map((source) => ({
              type: "local_path",
              ...source,
            })),
          }),
        },
        threads: {
          get: async ({ threadId }: { threadId: string }) => {
            const thread = state.threads[threadId];
            if (thread === undefined) throw new Error("Thread not found");
            return thread;
          },
        },
        files: {
          listPaths: async ({ path }: { path: string }) => {
            const prefix = `${path}/`;
            return {
              paths: Object.keys(state.files)
                .filter((file) => file.startsWith(prefix))
                .map((file) => ({
                  kind: "file",
                  path: file.slice(prefix.length),
                  name: file.slice(file.lastIndexOf("/") + 1),
                })),
              truncated: false,
            };
          },
          read: async ({ path }: { path: string }) => {
            const content = state.files[path];
            if (content === undefined) throw new Error("No such file");
            return {
              path,
              content,
              contentEncoding: "utf8",
              sizeBytes: content.length,
              sha256: "x",
            };
          },
          write: forbidden("write"),
          mkdir: forbidden("mkdir"),
          move: forbidden("move"),
          remove: forbidden("remove"),
        },
      },
    }),
  };
}

async function setup(options: SetupOptions = {}) {
  const state = {
    files: options.files ?? { [CUJ]: pageText(BODY) },
    threads: options.threads ?? {
      t1: { id: "t1", projectId: "p1" },
      t2: { id: "t2", projectId: "p2" },
    },
    sources: options.sources ?? [
      { hostId: "host-1", path: ROOT, isDefault: true },
    ],
  };
  const built = buildHost(state);
  await plugin(built.host.bb);
  return { ...built, state };
}

async function create(
  fake: Awaited<ReturnType<typeof setup>>,
  input: Record<string, unknown> = {},
) {
  return (await fake.host.harness.callRpc("createPin", {
    projectId: "p1",
    pageId: "cuj-boss",
    claim: null,
    body: "note",
    ...input,
  })) as { ok: boolean; reason?: string; pin?: Record<string, any> };
}

async function listPins(
  fake: Awaited<ReturnType<typeof setup>>,
  projectId = "p1",
) {
  return (await fake.host.harness.callRpc("pins", { projectId })) as Record<
    string,
    any
  >[];
}

describe("pins: persistence", () => {
  it("creates a page pin that lists with its anchor", async () => {
    const fake = await setup();
    const created = await create(fake, { body: "  remember this  " });
    expect(created.ok).toBe(true);
    const pins = await listPins(fake);
    expect(pins).toHaveLength(1);
    expect(pins[0]).toMatchObject({
      projectId: "p1",
      pageId: "cuj-boss",
      sourcePath: "docs/wiki/src/cujs/boss.md",
      claim: null,
      body: "remember this",
      resolvedAt: null,
      threadIds: [],
      anchor: { state: "page" },
    });
  });

  it("creates a claim pin anchored to the claim line", async () => {
    const fake = await setup();
    const created = await create(fake, { claim: FIRST });
    expect(created.ok).toBe(true);
    const [pin] = await listPins(fake);
    expect(pin?.claim).toEqual(FIRST);
    expect(pin?.anchor).toMatchObject({ state: "claim", line: 3 });
  });

  it("survives a plugin reload against the same database", async () => {
    const fake = await setup();
    await create(fake, { claim: FIRST, body: "keep" });
    const reloaded = await fake.host.harness.lifecycle.reload(plugin);
    const pins = (await reloaded.harness.callRpc("pins", {
      projectId: "p1",
    })) as Record<string, any>[];
    expect(pins.map((pin) => pin.body)).toEqual(["keep"]);
    expect(pins[0]?.anchor).toMatchObject({ state: "claim" });
  });

  it("only lists pins of the requested project", async () => {
    const fake = await setup();
    await create(fake);
    await create(fake, { projectId: "p2", body: "other" });
    expect((await listPins(fake)).map((pin) => pin.body)).toEqual(["note"]);
    expect((await listPins(fake, "p2")).map((pin) => pin.body)).toEqual([
      "other",
    ]);
  });

  it("detaches a claim pin when the claim text changes", async () => {
    const fake = await setup();
    await create(fake, { claim: FIRST });
    fake.state.files[CUJ] = pageText(
      BODY.replace("first question", "reworded question"),
    );
    const [pin] = await listPins(fake);
    expect(pin?.anchor).toEqual({
      state: "detached",
      reason: "claim-changed",
    });
  });

  it("marks a pin unverified, not detached, when the wiki cannot be read", async () => {
    const fake = await setup();
    await create(fake);
    fake.state.sources = [];
    const [pin] = await listPins(fake);
    expect(pin?.anchor.state).toBe("unverified");
  });
});

describe("pins: validation", () => {
  it("rejects a pin on a page that does not exist", async () => {
    const fake = await setup();
    const result = await create(fake, { pageId: "cuj-nope" });
    expect(result).toMatchObject({ ok: false, reason: "page-missing" });
    expect(await listPins(fake)).toEqual([]);
  });

  it("rejects an unknown claim without writing a row", async () => {
    const fake = await setup();
    const result = await create(fake, {
      claim: { ...FIRST, label: "Open: nope", context: "x" },
    });
    expect(result).toMatchObject({ ok: false, reason: "unknown-claim" });
    expect(await listPins(fake)).toEqual([]);
  });

  it("rejects a stale claim group size without writing a row", async () => {
    const fake = await setup();
    const result = await create(fake, { claim: { ...FIRST, groupSize: 2 } });
    expect(result).toMatchObject({ ok: false, reason: "stale-claim" });
    expect(await listPins(fake)).toEqual([]);
  });

  it("rejects a blank body", async () => {
    const fake = await setup();
    expect(await create(fake, { body: "   \n " })).toMatchObject({
      ok: false,
      reason: "invalid-body",
    });
    expect(await listPins(fake)).toEqual([]);
  });

  it("rejects a body longer than 4000 characters", async () => {
    const fake = await setup();
    const result = await fake.host.harness
      .callRpc("createPin", {
        projectId: "p1",
        pageId: "cuj-boss",
        claim: null,
        body: "x".repeat(4001),
      })
      .then(
        (value) => value as { ok: boolean; reason?: string },
        () => ({ ok: false, reason: "invalid-body" }),
      );
    expect(result).toMatchObject({ ok: false, reason: "invalid-body" });
    expect(await listPins(fake)).toEqual([]);
  });

  it("refuses to pin while the wiki is unavailable", async () => {
    const fake = await setup({ sources: [] });
    expect(await create(fake)).toMatchObject({
      ok: false,
      reason: "unverified",
    });
  });
});

describe("pins: update, resolve, delete", () => {
  it("edits the body and trims it", async () => {
    const fake = await setup();
    const id = (await create(fake)).pin?.id;
    const result = (await fake.host.harness.callRpc("updatePin", {
      projectId: "p1",
      pinId: id,
      body: "  changed ",
    })) as { ok: boolean; pin?: Record<string, any> };
    expect(result.ok).toBe(true);
    expect((await listPins(fake))[0]?.body).toBe("changed");
  });

  it("resolves and reopens a pin", async () => {
    const fake = await setup();
    const id = (await create(fake)).pin?.id;
    await fake.host.harness.callRpc("updatePin", {
      projectId: "p1",
      pinId: id,
      resolved: true,
    });
    expect((await listPins(fake))[0]?.resolvedAt).toEqual(expect.any(String));
    await fake.host.harness.callRpc("updatePin", {
      projectId: "p1",
      pinId: id,
      resolved: false,
    });
    expect((await listPins(fake))[0]?.resolvedAt).toBeNull();
  });

  it("treats another project's pin id as not found", async () => {
    const fake = await setup();
    const id = (await create(fake)).pin?.id;
    expect(
      await fake.host.harness.callRpc("updatePin", {
        projectId: "p2",
        pinId: id,
        body: "hijack",
      }),
    ).toMatchObject({ ok: false, reason: "not-found" });
    expect(
      await fake.host.harness.callRpc("deletePin", {
        projectId: "p2",
        pinId: id,
      }),
    ).toEqual({ deleted: false });
    expect(
      await fake.host.harness.callRpc("linkPinThread", {
        projectId: "p2",
        pinId: id,
        threadId: "t2",
      }),
    ).toMatchObject({ ok: false, reason: "not-found" });
    expect((await listPins(fake))[0]?.body).toBe("note");
  });

  it("deletes a pin", async () => {
    const fake = await setup();
    const id = (await create(fake)).pin?.id;
    expect(
      await fake.host.harness.callRpc("deletePin", {
        projectId: "p1",
        pinId: id,
      }),
    ).toEqual({ deleted: true });
    expect(await listPins(fake)).toEqual([]);
  });
});

describe("pins: linked threads", () => {
  it("links a thread of the same project, idempotently", async () => {
    const fake = await setup();
    const id = (await create(fake)).pin?.id;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect(
        await fake.host.harness.callRpc("linkPinThread", {
          projectId: "p1",
          pinId: id,
          threadId: "t1",
        }),
      ).toMatchObject({ ok: true });
    }
    expect((await listPins(fake))[0]?.threadIds).toEqual(["t1"]);
  });

  it("rejects a thread from another project", async () => {
    const fake = await setup();
    const id = (await create(fake)).pin?.id;
    expect(
      await fake.host.harness.callRpc("linkPinThread", {
        projectId: "p1",
        pinId: id,
        threadId: "t2",
      }),
    ).toMatchObject({ ok: false, reason: "wrong-project" });
    expect((await listPins(fake))[0]?.threadIds).toEqual([]);
  });

  it("rejects a thread that does not exist", async () => {
    const fake = await setup();
    const id = (await create(fake)).pin?.id;
    expect(
      await fake.host.harness.callRpc("linkPinThread", {
        projectId: "p1",
        pinId: id,
        threadId: "ghost",
      }),
    ).toMatchObject({ ok: false, reason: "thread-not-found" });
  });

  it("removes thread links when the pin is deleted", async () => {
    const fake = await setup();
    const id = (await create(fake)).pin?.id;
    await fake.host.harness.callRpc("linkPinThread", {
      projectId: "p1",
      pinId: id,
      threadId: "t1",
    });
    await fake.host.harness.callRpc("deletePin", {
      projectId: "p1",
      pinId: id,
    });
    const db = fake.host.bb.storage.database();
    expect(db.prepare("SELECT COUNT(*) AS n FROM pin_threads").get()).toEqual({
      n: 0,
    });
  });
});

describe("pins: freshness and discoverability", () => {
  it("declares the project pins tag and invalidates it on every mutation", async () => {
    const fake = await setup();
    const id = (await create(fake)).pin?.id;
    await fake.host.harness.callRpc("updatePin", {
      projectId: "p1",
      pinId: id,
      body: "b",
    });
    await fake.host.harness.callRpc("linkPinThread", {
      projectId: "p1",
      pinId: id,
      threadId: "t1",
    });
    await fake.host.harness.callRpc("deletePin", {
      projectId: "p1",
      pinId: id,
    });
    const tags = fake.host.harness.experimental_rpcInvalidations.flat(2);
    expect(
      tags.filter((tag: unknown) => tag === "design-wiki:pins:p1"),
    ).toHaveLength(4);
  });
});

describe("pins never edit the repository", () => {
  it("never calls a file write method and leaves page content unchanged", async () => {
    const fake = await setup();
    const before = JSON.stringify(fake.state.files);
    const id = (await create(fake, { claim: FIRST })).pin?.id;
    await fake.host.harness.callRpc("updatePin", {
      projectId: "p1",
      pinId: id,
      body: "x",
      resolved: true,
    });
    await fake.host.harness.callRpc("linkPinThread", {
      projectId: "p1",
      pinId: id,
      threadId: "t1",
    });
    await listPins(fake);
    await fake.host.harness.callRpc("deletePin", {
      projectId: "p1",
      pinId: id,
    });
    expect(fake.writes).toEqual([]);
    expect(JSON.stringify(fake.state.files)).toBe(before);
    const methods = fake.host.harness.sdk.calls.map((call) => call.path);
    expect(
      methods.filter((path) => /write|mkdir|move|remove/.test(path)),
    ).toEqual([]);
  });
});

describe("pins: storage migrations", () => {
  it("keeps stored pins when a migration is appended", async () => {
    const fake = await setup();
    await create(fake, { claim: FIRST, body: "keep" });
    const reloaded = await fake.host.harness.lifecycle.reload(async (bb) => {
      await plugin(bb);
      bb.storage.migrate(bb.storage.database(), [
        ...PIN_MIGRATIONS,
        "CREATE TABLE pin_extra (pin_id TEXT PRIMARY KEY);",
      ]);
    });
    const pins = (await reloaded.harness.callRpc("pins", {
      projectId: "p1",
    })) as Record<string, any>[];
    expect(pins.map((pin) => pin.body)).toEqual(["keep"]);
  });

  it("rejects a modified shipped migration statement", async () => {
    const fake = await setup();
    await create(fake);
    await expect(
      fake.host.harness.lifecycle.reload(async (bb) => {
        bb.storage.migrate(bb.storage.database(), [
          `${PIN_MIGRATIONS[0]} -- edited`,
        ]);
      }),
    ).rejects.toThrow();
    expect((await listPins(fake)).length).toBe(1);
  });
});
