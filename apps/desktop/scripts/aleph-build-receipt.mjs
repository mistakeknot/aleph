import { createHash } from "node:crypto";
import {
  lstat,
  readFile,
  readdir,
  readlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export async function digestFile(path) {
  return sha256(await readFile(path));
}

async function collectTreeLines(root, relative, lines) {
  const path = relative === "" ? root : join(root, relative);
  const stats = await lstat(path);
  if (stats.isSymbolicLink()) {
    lines.push(`l ${relative} ${await readlink(path)}`);
    return;
  }
  if (stats.isDirectory()) {
    lines.push(`d ${relative}`);
    const names = (await readdir(path)).sort();
    for (const name of names) {
      await collectTreeLines(root, join(relative, name), lines);
    }
    return;
  }
  const executable = (stats.mode & 0o111) === 0 ? "-" : "x";
  lines.push(`f ${relative} ${executable} ${await digestFile(path)}`);
}

export async function digestTree(path) {
  const lines = [];
  await collectTreeLines(path, "", lines);
  return sha256(lines.join("\n"));
}

async function digestFiles(paths) {
  const parts = [];
  for (const path of [...paths].sort()) {
    parts.push(await digestFile(path));
  }
  return sha256(parts.join("\n"));
}

export async function createBuildReceipt({
  appPath,
  lockfilePath,
  recipePaths,
  repoId,
  sourceSha,
  toolVersions,
  version,
}) {
  if (typeof repoId !== "string" || repoId.trim().length === 0) {
    throw new Error("A build receipt needs the immutable repository ID.");
  }
  if (!/^[0-9a-f]{40}$/u.test(sourceSha)) {
    throw new Error("A build receipt needs a full 40-character source SHA.");
  }
  if (typeof version !== "string" || version.length === 0) {
    throw new Error("A build receipt needs the release version.");
  }

  return {
    artifact_digest: await digestTree(appPath),
    lockfile_digest: await digestFile(lockfilePath),
    recipe_digest: await digestFiles(recipePaths),
    repo_id: repoId.trim(),
    schema: "aleph-build-receipt/1",
    source_sha: sourceSha,
    tool_versions: toolVersions,
    version,
  };
}

function readFlag(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

async function main() {
  const args = process.argv.slice(2);
  const required = [
    "--app",
    "--lockfile",
    "--repo-id",
    "--sha",
    "--version",
    "--out",
  ];
  for (const flag of required) {
    if (readFlag(args, flag) === undefined) {
      throw new Error(
        `Usage: aleph-build-receipt.mjs ${required.map((name) => `${name} <value>`).join(" ")} [--recipe <file>]...`,
      );
    }
  }
  const recipePaths = args.flatMap((arg, index) =>
    arg === "--recipe" ? [args[index + 1]] : [],
  );
  const receipt = await createBuildReceipt({
    appPath: readFlag(args, "--app"),
    lockfilePath: readFlag(args, "--lockfile"),
    recipePaths,
    repoId: readFlag(args, "--repo-id"),
    sourceSha: readFlag(args, "--sha"),
    toolVersions: { node: process.versions.node },
    version: readFlag(args, "--version"),
  });
  await writeFile(
    readFlag(args, "--out"),
    `${JSON.stringify(receipt, null, 2)}\n`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
