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

  function fakePrerequisite(root: string, body: string): GeneratedPrerequisite {
    touch(join(root, "pkg/build.mjs"), body);
    return {
      label: "fake artifact",
      packageDir: "pkg",
      script: "build.mjs",
      outputs: async () => ["out.txt"],
    };
  }

  it("lets concurrent builds finish without exposing a partial output", async () => {
    const root = emptyRoot();
    const prerequisite = fakePrerequisite(
      root,
      [
        'import { appendFileSync, renameSync, writeFileSync } from "node:fs";',
        'appendFileSync("builds.log", "x\\n");',
        "await new Promise((resolve) => setTimeout(resolve, 300));",
        'writeFileSync(`out.txt.${process.pid}`, "done");',
        'renameSync(`out.txt.${process.pid}`, "out.txt");',
      ].join("\n"),
    );
    await Promise.all([
      ensurePrerequisite(prerequisite, root),
      ensurePrerequisite(prerequisite, root),
      ensurePrerequisite(prerequisite, root),
    ]);
    expect(readFileSync(join(root, "pkg/out.txt"), "utf8")).toBe("done");
    expect(await isMissing(prerequisite, root)).toBe(false);
  });

  it("skips the build when the outputs already exist", async () => {
    const root = emptyRoot();
    const prerequisite = fakePrerequisite(root, 'throw new Error("ran");');
    touch(join(root, "pkg/out.txt"), "done");
    await ensurePrerequisite(prerequisite, root);
  });

  it("reports a failing build with its exit code and output", async () => {
    const root = emptyRoot();
    const prerequisite = fakePrerequisite(root, 'throw new Error("boom");');
    await expect(ensurePrerequisite(prerequisite, root)).rejects.toThrow(
      /Could not build fake artifact before the server tests: exited with code 1: [\s\S]*boom/,
    );
  });

  it("fails with a descriptive error when the build exceeds its timeout", async () => {
    const root = emptyRoot();
    const prerequisite = fakePrerequisite(
      root,
      "await new Promise((resolve) => setTimeout(resolve, 30000));",
    );
    await expect(
      ensurePrerequisite(prerequisite, root, {
        timeoutMs: 500,
        killGraceMs: 200,
      }),
    ).rejects.toThrow(
      "Could not build fake artifact before the server tests: timed out after 500 ms",
    );
  });

  it("force-kills a build that ignores SIGTERM", async () => {
    const root = emptyRoot();
    const prerequisite = fakePrerequisite(
      root,
      [
        'import { writeFileSync } from "node:fs";',
        'process.on("SIGTERM", () => {});',
        'writeFileSync("child.pid", String(process.pid));',
        "setInterval(() => {}, 1000);",
      ].join("\n"),
    );
    const started = Date.now();
    await expect(
      ensurePrerequisite(prerequisite, root, {
        timeoutMs: 1500,
        killGraceMs: 300,
      }),
    ).rejects.toThrow("timed out after 1500 ms");
    expect(Date.now() - started).toBeLessThan(10_000);
    const pid = Number(readFileSync(join(root, "pkg/child.pid"), "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
  });
});
