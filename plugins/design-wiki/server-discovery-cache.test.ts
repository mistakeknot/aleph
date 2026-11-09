import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "./server.js";

const ROOT = "/work/proj";
const CUJ_DIR = `${ROOT}/docs/wiki/src/cujs`;

function doc(id: string) {
  return `---\nid: ${id}\nstatus: ruled\ncard: "ACME-1"\nsource: docs/x.md\nupdated: 2026-11-03\n---\n\n# ${id}\n\n**Ruled — ACME-1:** claim.\n`;
}

async function setup(options: { failFirstProject?: boolean } = {}) {
  const files: Record<string, string> = {
    [`${CUJ_DIR}/a.md`]: doc("cuj-a"),
    [`${CUJ_DIR}/b.md`]: doc("cuj-b"),
  };
  const counts = { project: 0, list: 0, read: 0 };
  let failProject = options.failFirstProject === true;
  const fake = createFakePluginHost({
    pluginId: "bb--design-wiki",
    sdk: {
      projects: {
        list: async () => [],
        get: async ({ projectId }: { projectId: string }) => {
          counts.project += 1;
          await new Promise((resolve) => setTimeout(resolve, 5));
          if (failProject) {
            failProject = false;
            throw new Error("host busy");
          }
          return {
            id: projectId,
            name: "Proj",
            sources: [
              {
                type: "local_path",
                hostId: "host-1",
                path: ROOT,
                isDefault: true,
              },
            ],
          };
        },
      },
      files: {
        listPaths: async ({ path }: { path: string }) => {
          counts.list += 1;
          const prefix = `${path}/`;
          return {
            paths: Object.keys(files)
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
          counts.read += 1;
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
  return { fake, counts, files };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Design Wiki discovery sharing", () => {
  it("reads the wiki once for a list and page requested together", async () => {
    const { fake, counts } = await setup();
    const [list, page] = await Promise.all([
      fake.harness.callRpc("list", { projectId: "p1" }),
      fake.harness.callRpc("page", { projectId: "p1", pageId: "cuj-a" }),
    ]);
    expect(counts.project).toBe(1);
    expect(counts.read).toBe(2);
    expect(page).toMatchObject({ state: "found" });
    expect(list).toMatchObject({ state: "ready" });
  });

  it("serves a repeat request from the recent read", async () => {
    const { fake, counts } = await setup();
    await fake.harness.callRpc("list", { projectId: "p1" });
    await fake.harness.callRpc("page", { projectId: "p1", pageId: "cuj-b" });
    await fake.harness.callRpc("list", { projectId: "p1" });
    expect(counts.project).toBe(1);
    expect(counts.read).toBe(2);
  });

  it("reads again once the recent read has aged out", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { fake, counts, files } = await setup();
    await fake.harness.callRpc("list", { projectId: "p1" });
    files[`${CUJ_DIR}/c.md`] = doc("cuj-c");
    vi.setSystemTime(Date.now() + 60_000);
    const list = (await fake.harness.callRpc("list", {
      projectId: "p1",
    })) as { pages: { id: string }[] };
    expect(counts.project).toBe(2);
    expect(list.pages.map((entry) => entry.id)).toContain("cuj-c");
  });

  it("does not remember a failed read", async () => {
    const { fake, counts } = await setup({ failFirstProject: true });
    const first = (await fake.harness.callRpc("list", {
      projectId: "p1",
    })) as { state: string };
    const second = (await fake.harness.callRpc("list", {
      projectId: "p1",
    })) as { state: string };
    expect(first.state).toBe("unavailable");
    expect(second.state).toBe("ready");
    expect(counts.project).toBe(2);
  });

  it("keeps projects apart", async () => {
    const { fake, counts } = await setup();
    await fake.harness.callRpc("list", { projectId: "p1" });
    await fake.harness.callRpc("list", { projectId: "p2" });
    expect(counts.project).toBe(2);
  });
});
