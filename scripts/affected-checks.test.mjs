import assert from "node:assert/strict";
import test from "node:test";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
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
  assert.equal(
    evaluateChanges(["packages/shared-ui/src/example.ts"], query("@bb/a"), {
      tasks: {
        "@bb/b#test": { inputs: ["$TURBO_ROOT$/packages/shared-ui/src/**"] },
      },
    }),
    "full",
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
test("historical package diff with real Turbo config selects affected commands", () => {
  const root = process.cwd();
  const fixture = mkdtempSync(join(tmpdir(), "affected-history-"));
  mkdirSync(join(fixture, "scripts"));
  const manifests = execFileSync(
    "git",
    [
      "ls-files",
      "--",
      "package.json",
      "**/package.json",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      "turbo.json",
      "scripts/ci-test-shards.json",
    ],
    { encoding: "utf8" },
  )
    .trim()
    .split("\n");
  for (const file of manifests) {
    const target = join(fixture, file);
    mkdirSync(resolve(target, ".."), { recursive: true });
    copyFileSync(file, target);
  }
  mkdirSync(join(fixture, "packages/domain/test"), { recursive: true });
  writeFileSync(
    join(fixture, "packages/domain/test/example.ts"),
    "export const a = 1;\n",
  );
  const git = (...args) =>
    execFileSync("git", args, { cwd: fixture, encoding: "utf8" });
  git("init", "--quiet");
  git("add", ".");
  const commit = () =>
    git(
      "-c",
      "user.name=CI",
      "-c",
      "user.email=ci@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "fixture",
    );
  commit();
  const base = git("rev-parse", "HEAD").trim();
  writeFileSync(
    join(fixture, "packages/domain/test/example.ts"),
    "export const a = 2;\n",
  );
  git("add", ".");
  commit();
  symlinkSync(
    resolve(root, "node_modules"),
    join(fixture, "node_modules"),
    "dir",
  );
  const output = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { selectRefs } from ${JSON.stringify(pathToFileURL(resolve("scripts/affected-checks.mjs")).href)}; console.log(JSON.stringify(selectRefs(${JSON.stringify(base)}, "HEAD")));`,
    ],
    { cwd: fixture, encoding: "utf8", timeout: 30000 },
  );
  const commands = JSON.parse(output);
  assert.notEqual(commands, "full");
  assert.ok(commands.flat().includes("--filter=@bb/domain"));
});

test("qualification environment cannot execute affected commands", () => {
  const commands = [["pnpm", "exec", "turbo", "run", "test", "--filter=a"]];
  assert.equal(executionPlan(commands, {}).qualificationEligible, false);
  assert.deepEqual(executionPlan(commands, { CI_SOURCE_SHA: "sha" }).commands, [
    ["pnpm", "test"],
  ]);
});

test("shared build dependency input requires full", () => {
  assert.equal(
    evaluateChanges(
      ["packages/plugin-build/src/zod-locale-stub.mjs"],
      query("@bb/plugin-build"),
      turbo,
    ),
    "full",
  );
  assert.deepEqual(
    evaluateChanges(
      ["packages/domain/test/example.ts"],
      query("@bb/domain"),
      turbo,
    ),
    [{ name: "test", package: "@bb/domain" }],
  );
});
