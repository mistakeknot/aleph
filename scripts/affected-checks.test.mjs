import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { evaluateChanges, parseTurbo, sharedTestInputs } from "./plan-ci.mjs";
import { executionPlan, selectRefs } from "./affected-checks.mjs";
const turbo = parseTurbo(readFileSync("turbo.json", "utf8"));
const query = (...names) => ({
  data: {
    affectedTasks: {
      items: names.map((name) => ({ name: "test", package: { name } })),
    },
  },
});
const select = (paths, names = ["@bb/a"]) =>
  evaluateChanges(paths, query(...names), { tasks: {} });
test("mixed mapped and unmapped paths require full", () =>
  assert.equal(select(["packages/a/src/a.ts", "pnpm-lock.yaml"]), "full"));
test("multiple packages preserve test targets", () =>
  assert.deepEqual(
    select(
      ["packages/a/src/a.ts", "packages/b/test/b.ts"],
      ["@bb/a", "@bb/b"],
    ).map((x) => x.package),
    ["@bb/a", "@bb/b"],
  ));
for (const path of [
  "pnpm-lock.yaml",
  "scripts/ci-release-check.sh",
  "turbo.json",
  "vitest.config.ts",
  "package.json",
  ".npmrc",
  "docs/unknown.md",
  "packages/a/data/a.json",
  "packages/a/vitest.config.ts",
  "packages/a/scripts/build.ts",
])
  test(`${path} requires full`, () => assert.equal(select([path]), "full"));
test("JSONC and real shared inputs are parsed", () => {
  assert.ok(Object.keys(turbo.tasks).length > 10);
  assert.ok(sharedTestInputs(turbo).includes("vitest*.ts"));
  assert.ok(
    evaluateChanges(["packages/shared-ui/src/example.ts"], query("@bb/a"), {
      tasks: {
        "@bb/b#test": { inputs: ["$TURBO_ROOT$/packages/shared-ui/src/**"] },
      },
    }).some((task) => task.package === "@bb/b"),
  );
});
test("real globs do not consume sibling source files", () => {
  const config = {
    tasks: {
      test: { dependsOn: ["build"] },
      build: { inputs: ["$TURBO_ROOT$/plugins/*/icons/*.svg"] },
      unrelated: { inputs: ["$TURBO_ROOT$/packages/**"] },
    },
  };
  assert.notEqual(
    evaluateChanges(["plugins/foo/src/a.ts"], query("foo"), config),
    "full",
  );
});
test("invalid query throws for caller fallback", () =>
  assert.throws(() =>
    evaluateChanges(["packages/a/src/a.ts"], {}, { tasks: {} }),
  ));
test("invalid refs fall back to full", () =>
  assert.equal(selectRefs("missing-ref", "HEAD"), "full"));
test("historical package diff with real Turbo config selects affected commands", () =>
  assert.notEqual(selectRefs("02ce70521c^", "02ce70521c"), "full"));

test("qualification environment cannot execute affected commands", () => {
  const commands = [["pnpm", "exec", "turbo", "run", "test", "--filter=a"]];
  assert.equal(executionPlan(commands, {}).qualificationEligible, false);
  assert.deepEqual(executionPlan(commands, { CI_SOURCE_SHA: "sha" }).commands, [
    ["pnpm", "test"],
  ]);
});
