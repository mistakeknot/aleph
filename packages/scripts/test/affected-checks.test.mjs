import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test, expect } from "vitest";

test("affected check selector safety contracts", () => {
  const output = execFileSync(
    process.execPath,
    ["--test", "scripts/affected-checks.test.mjs"],
    {
      cwd: fileURLToPath(new URL("../../../", import.meta.url)),
      encoding: "utf8",
      timeout: 30000,
    },
  );
  expect(output).toContain("# fail 0");
}, 35000);
