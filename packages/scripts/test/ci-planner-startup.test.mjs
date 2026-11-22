import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

test("CI planner starts after checkout without node_modules", () => {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const checkout = mkdtempSync(join(tmpdir(), "ci-planner-checkout-"));
  mkdirSync(join(checkout, "scripts"));
  for (const file of ["plan-ci.mjs", "ci-test-shards.json"]) {
    copyFileSync(join(root, "scripts", file), join(checkout, "scripts", file));
  }
  const result = spawnSync(
    process.execPath,
    ["scripts/plan-ci.mjs", "--full"],
    {
      cwd: checkout,
      encoding: "utf8",
      env: { ...process.env, NODE_PATH: "", NODE_OPTIONS: "" },
    },
  );
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({
    reason: "Full cross-platform coverage",
    buildNeeded: true,
    staticNeeded: true,
  });
});
