import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type GeneratedPrerequisite,
  GENERATED_PREREQUISITES,
  ensurePrerequisite,
  isMissing,
  missingPrerequisites,
  withBuildLock,
} from "./ensure-test-prerequisites.js";

const repoRoot = join(import.meta.dirname, "../../../..");
const sdkPrerequisite = GENERATED_PREREQUISITES[1]!;

describe("ensureTestPrerequisites", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  function emptyRoot(): string {
    const root = mkdtempSync(join(tmpdir(), "bb-prerequisites-"));
    roots.push(root);
    return root;
  }

  function touch(path: string, contents = ""): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
  }

  async function populate(root: string): Promise<void> {
    for (const prerequisite of GENERATED_PREREQUISITES) {
      for (const output of await prerequisite.outputs()) {
        touch(join(root, prerequisite.packageDir, output));
      }
    }
  }

  it("reports every prerequisite when nothing is built", async () => {
    expect(
      await missingPrerequisites(GENERATED_PREREQUISITES, emptyRoot()),
    ).toEqual(GENERATED_PREREQUISITES);
  });

  it("derives the plugin SDK outputs from its package exports", async () => {
    const manifest = JSON.parse(
      readFileSync(join(repoRoot, "packages/plugin-sdk/package.json"), "utf8"),
    ) as { exports: Record<string, { import: string }> };
    const outputs = await sdkPrerequisite.outputs();
    for (const entry of Object.values(manifest.exports)) {
      expect(outputs).toContain(entry.import.slice(2));
    }
    expect(outputs).toContain("dist/provider-bridge.js");
  });

  it("reports nothing missing once every output exists", async () => {
    const root = emptyRoot();
    await populate(root);
    expect(await missingPrerequisites(GENERATED_PREREQUISITES, root)).toEqual(
      [],
    );
  });

  it("reports the SDK as missing when any single exported output is absent", async () => {
    const outputs = await sdkPrerequisite.outputs();
    for (const output of outputs) {
      const root = emptyRoot();
      await populate(root);
      rmSync(join(root, sdkPrerequisite.packageDir, output));
      expect(await isMissing(sdkPrerequisite, root)).toBe(true);
    }
  });

  it("never runs two locked sections at once", async () => {
    const lockDir = join(emptyRoot(), "build.lock");
    let active = 0;
    let overlapped = false;
    const section = async (): Promise<void> => {
      active += 1;
      overlapped ||= active > 1;
      await new Promise((resolve) => setTimeout(resolve, 80));
      active -= 1;
    };
    const options = { waitMs: 5000, staleMs: 60_000 };
    await Promise.all([
      withBuildLock(lockDir, section, options),
      withBuildLock(lockDir, section, options),
      withBuildLock(lockDir, section, options),
    ]);
    expect(overlapped).toBe(false);
  });

  it("takes over a lock whose holder has exited", async () => {
    const lockDir = join(emptyRoot(), "build.lock");
    touch(join(lockDir, "pid"), "2147483646");
    let ran = false;
    await withBuildLock(
      lockDir,
      async () => {
        ran = true;
      },
      { waitMs: 2000, staleMs: 60_000 },
    );
    expect(ran).toBe(true);
  });

  it("gives up waiting on a lock that is still held", async () => {
    const lockDir = join(emptyRoot(), "build.lock");
    touch(join(lockDir, "pid"), String(process.pid));
    await expect(
      withBuildLock(lockDir, async () => undefined, {
        waitMs: 250,
        staleMs: 60_000,
      }),
    ).rejects.toThrow("Timed out waiting for the build lock");
  });

  function fakePrerequisite(root: string, body: string): GeneratedPrerequisite {
    touch(join(root, "pkg/build.mjs"), body);
    return {
      label: "fake artifact",
      packageDir: "pkg",
      script: "build.mjs",
      outputs: async () => ["out.txt"],
    };
  }

  it("builds once when two runs race, rechecking after the lock", async () => {
    const root = emptyRoot();
    const prerequisite = fakePrerequisite(
      root,
      [
        'import { appendFileSync, writeFileSync } from "node:fs";',
        'appendFileSync("builds.log", "x\\n");',
        "await new Promise((resolve) => setTimeout(resolve, 300));",
        'writeFileSync("out.txt", "done");',
      ].join("\n"),
    );
    const options = { lockDir: join(root, "build.lock") };
    await Promise.all([
      ensurePrerequisite(prerequisite, root, options),
      ensurePrerequisite(prerequisite, root, options),
    ]);
    expect(readFileSync(join(root, "pkg/builds.log"), "utf8")).toBe("x\n");
    expect(await isMissing(prerequisite, root)).toBe(false);
  });

  it("fails with a descriptive error when the build exceeds its timeout", async () => {
    const root = emptyRoot();
    const prerequisite = fakePrerequisite(
      root,
      "await new Promise((resolve) => setTimeout(resolve, 30000));",
    );
    await expect(
      ensurePrerequisite(prerequisite, root, {
        lockDir: join(root, "build.lock"),
        timeoutMs: 300,
      }),
    ).rejects.toThrow(
      "Could not build fake artifact before the server tests: timed out after 300 ms",
    );
  });
});
