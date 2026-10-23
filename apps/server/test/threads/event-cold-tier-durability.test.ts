import { constants as fsConstants } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const syncs = vi.hoisted(() => ({
  failNext: new Set<string>(),
  synced: [] as string[],
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const open: typeof actual.open = async (path, flags, mode) => {
    const handle = await actual.open(path, flags, mode);
    const target = String(path);
    const isDirectory =
      typeof flags === "number" && (flags & fsConstants.O_DIRECTORY) !== 0;
    const sync = handle.sync.bind(handle);
    handle.sync = async () => {
      if (syncs.failNext.delete(target)) {
        throw Object.assign(new Error("injected fsync failure"), {
          code: "EIO",
        });
      }
      await sync();
      if (isDirectory) syncs.synced.push(target);
    };
    return handle;
  };
  return { ...actual, open };
});

const { durableMkdir } =
  await import("../../src/services/threads/event-cold-tier/segment-files.js");
const { ColdManifest, coldManifestPath, readColdManifestEntries } =
  await import("../../src/services/threads/event-cold-tier/manifest.js");

describe("cold-tier durability under I/O errors", () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "bb-cold-durability-"));
    syncs.failNext.clear();
    syncs.synced.length = 0;
  });

  afterEach(async () => {
    await rm(dataDir, { force: true, recursive: true });
  });

  it("syncs the parent entry on a retry after the first sync failed", async () => {
    syncs.failNext.add(dataDir);
    await expect(durableMkdir(dataDir, "event-archive/thr_a")).rejects.toThrow(
      "injected fsync failure",
    );
    expect(syncs.synced).not.toContain(dataDir);

    await durableMkdir(dataDir, "event-archive/thr_a");

    const archiveDir = join(dataDir, "event-archive");
    expect(syncs.synced).toEqual(
      expect.arrayContaining([dataDir, archiveDir, join(archiveDir, "thr_a")]),
    );
  });

  it("keeps the manifest chain intact after an append whose fsync failed", async () => {
    const manifest = new ColdManifest(dataDir);
    await manifest.recover(1);
    await manifest.append({
      at: 1,
      kind: "pending",
      segmentId: "s1",
      threadId: "t",
    });

    syncs.failNext.add(coldManifestPath(dataDir));
    await expect(
      manifest.append({
        at: 2,
        kind: "committed",
        segmentId: "s1",
        threadId: "t",
      }),
    ).rejects.toThrow("injected fsync failure");

    await manifest.append({
      at: 3,
      kind: "pending",
      segmentId: "s2",
      threadId: "t",
    });
    await manifest.append({
      at: 4,
      kind: "committed",
      segmentId: "s2",
      threadId: "t",
    });

    const entries = await readColdManifestEntries(dataDir);
    expect(entries.map((entry) => entry.at)).toEqual([1, 2, 3, 4]);
    for (let index = 1; index < entries.length; index += 1) {
      expect(entries[index]!.prev).toBe(entries[index - 1]!.hash);
    }
    await expect(new ColdManifest(dataDir).recover(5)).resolves.toMatchObject({
      entries: 4,
      tornBytes: 0,
    });
  });
});
