import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createBuildReceipt,
  digestTree,
} from "../scripts/aleph-build-receipt.mjs";

const temporaryDirectories: string[] = [];

async function createApp(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "aleph-receipt-"));
  temporaryDirectories.push(root);
  const app = join(root, "Aleph.app");
  await mkdir(join(app, "Contents", "MacOS"), { recursive: true });
  await writeFile(join(app, "Contents", "MacOS", "Aleph"), "binary");
  await writeFile(join(app, "Contents", "Info.plist"), "plist");
  return app;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("digestTree", () => {
  it("is stable for identical content", async () => {
    const first = await createApp();
    const second = await createApp();

    expect(await digestTree(first)).toBe(await digestTree(second));
    expect(await digestTree(first)).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("changes when a file changes, is added, or is renamed", async () => {
    const app = await createApp();
    const before = await digestTree(app);

    await writeFile(join(app, "Contents", "MacOS", "Aleph"), "tampered");
    const changed = await digestTree(app);
    await writeFile(join(app, "Contents", "extra"), "x");
    const added = await digestTree(app);

    expect(new Set([before, changed, added]).size).toBe(3);
  });

  it("records symlink targets without following them", async () => {
    const app = await createApp();
    await symlink("/etc/passwd", join(app, "Contents", "link"));
    const first = await digestTree(app);
    await rm(join(app, "Contents", "link"));
    await symlink("/etc/hosts", join(app, "Contents", "link"));

    expect(await digestTree(app)).not.toBe(first);
  });
});

describe("createBuildReceipt", () => {
  it("binds repo, source, recipe, lockfile and artifact digests", async () => {
    const app = await createApp();
    const lockfile = join(app, "..", "pnpm-lock.yaml");
    const recipe = join(app, "..", "recipe.json");
    await writeFile(lockfile, "lock");
    await writeFile(recipe, "recipe");

    const receipt = await createBuildReceipt({
      appPath: app,
      lockfilePath: lockfile,
      recipePaths: [recipe],
      repoId: "R_kgDOAbc123",
      sourceSha: "3e7e1a3b4750e67f9af1f60efed1900111740413",
      toolVersions: { node: "24.0.0" },
      version: "0.5.0",
    });

    expect(receipt).toMatchObject({
      repo_id: "R_kgDOAbc123",
      schema: "aleph-build-receipt/1",
      source_sha: "3e7e1a3b4750e67f9af1f60efed1900111740413",
      tool_versions: { node: "24.0.0" },
      version: "0.5.0",
    });
    expect(receipt.artifact_digest).toBe(await digestTree(app));
    expect(receipt.lockfile_digest).toMatch(/^[0-9a-f]{64}$/u);
    expect(receipt.recipe_digest).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("rejects a source SHA that is not a full commit hash", async () => {
    const app = await createApp();
    await expect(
      createBuildReceipt({
        appPath: app,
        lockfilePath: join(app, "Contents", "Info.plist"),
        recipePaths: [],
        repoId: "R_kgDOAbc123",
        sourceSha: "main",
        toolVersions: {},
        version: "0.5.0",
      }),
    ).rejects.toThrow("source SHA");
  });

  it("rejects an empty repository ID", async () => {
    const app = await createApp();
    await expect(
      createBuildReceipt({
        appPath: app,
        lockfilePath: join(app, "Contents", "Info.plist"),
        recipePaths: [],
        repoId: "",
        sourceSha: "3e7e1a3b4750e67f9af1f60efed1900111740413",
        toolVersions: {},
        version: "0.5.0",
      }),
    ).rejects.toThrow("repository ID");
  });
});
