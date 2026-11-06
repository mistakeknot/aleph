import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  GENERATED_PREREQUISITES,
  missingPrerequisites,
} from "./ensure-test-prerequisites.js";

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

  it("reports every prerequisite when nothing is built", () => {
    expect(missingPrerequisites(GENERATED_PREREQUISITES, emptyRoot())).toEqual(
      GENERATED_PREREQUISITES,
    );
  });

  it("reports a prerequisite whose outputs are only partly present", () => {
    const root = emptyRoot();
    for (const prerequisite of GENERATED_PREREQUISITES) {
      for (const output of prerequisite.outputs) {
        const path = join(root, prerequisite.packageDir, output);
        mkdirSync(join(path, ".."), { recursive: true });
        writeFileSync(path, "");
      }
    }
    expect(missingPrerequisites(GENERATED_PREREQUISITES, root)).toEqual([]);
    rmSync(
      join(
        root,
        GENERATED_PREREQUISITES[1]!.packageDir,
        GENERATED_PREREQUISITES[1]!.outputs[2]!,
      ),
    );
    expect(
      missingPrerequisites(GENERATED_PREREQUISITES, root).map(
        (prerequisite) => prerequisite.packageDir,
      ),
    ).toEqual(["packages/plugin-sdk"]);
  });
});
