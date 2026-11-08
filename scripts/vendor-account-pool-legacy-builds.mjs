#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = join(
  repoRoot,
  "plugins/account-pool/src/fixtures/legacy-builds",
);
const USAGE =
  "Usage: node scripts/vendor-account-pool-legacy-builds.mjs [--check]\n\n" +
  "Writes the account-pool quota storage code of the pinned historical\n" +
  "commits (contracts, quota history, store and the plugin storage migration\n" +
  "runner, all byte-for-byte from git) into\n" +
  "plugins/account-pool/src/fixtures/legacy-builds. --check regenerates in\n" +
  "memory and fails when the committed files differ.";

const BUILDS = [
  { name: "old", commit: "cd650e592e018b8c63b0f2f2b43075480f51c481" },
  { name: "a0", commit: "db0226b7d170e21aa9a960cdfd0b08947a4bca75" },
];
const PLUGIN_FILES = ["contracts.ts", "quota-history.ts", "store.ts"];
const RUNNER_PATH = "packages/plugin-sdk/src/internal/host-policy.ts";
const RUNNER_START = "const LEGACY_UNKNOWN_MIGRATION_HASH";
const RUNNER_END = "export function normalizeHttpRouteRegistration";
const RUNNER_HEADER =
  'import { createHash } from "node:crypto";\nimport type Database from "better-sqlite3";\n\n';

function show(commit, path) {
  return execFileSync("git", ["show", `${commit}:${path}`], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

function extractRunner(source, commit) {
  const start = source.indexOf(RUNNER_START);
  const end = source.indexOf(RUNNER_END);
  if (start < 0 || end < 0 || end <= start) {
    throw new Error(
      `The storage migration runner markers are missing at ${commit}.`,
    );
  }
  const body = source.slice(start, end).trimEnd();
  if (!body.includes("export function runPluginStorageMigrations(")) {
    throw new Error(`runPluginStorageMigrations is missing at ${commit}.`);
  }
  return `${RUNNER_HEADER}${body}\n`;
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function generate() {
  const files = new Map();
  const manifest = { builds: {} };
  for (const build of BUILDS) {
    const hashes = {};
    for (const file of PLUGIN_FILES) {
      const text = show(build.commit, `plugins/account-pool/src/${file}`);
      files.set(`${build.name}/${file}`, text);
      hashes[file] = sha256(text);
    }
    const runner = extractRunner(show(build.commit, RUNNER_PATH), build.commit);
    files.set(`${build.name}/migration-runner.ts`, runner);
    hashes["migration-runner.ts"] = sha256(runner);
    manifest.builds[build.name] = { commit: build.commit, files: hashes };
  }
  files.set("manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);
  return files;
}

const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log(USAGE);
  process.exit(0);
}
const check = args.includes("--check");
const unknown = args.filter((arg) => arg !== "--check");
if (unknown.length > 0) {
  console.error(USAGE);
  process.exit(2);
}

const files = generate();
if (check) {
  const stale = [];
  for (const [name, text] of files) {
    const path = join(outputDir, name);
    if (!existsSync(path) || readFileSync(path, "utf8") !== text) {
      stale.push(name);
    }
  }
  if (stale.length > 0) {
    console.error(`Out of date: ${stale.join(", ")}`);
    process.exit(1);
  }
  console.log(`legacy builds match ${BUILDS.length} pinned commits`);
} else {
  rmSync(outputDir, { recursive: true, force: true });
  for (const [name, text] of files) {
    const path = join(outputDir, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }
  console.log(`wrote ${files.size} files to ${outputDir}`);
}
