#!/usr/bin/env node
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const SHRINKWRAP = "npm-shrinkwrap.json";
const PACKAGE_LOCK = "package-lock.json";
const EXACT_VERSION = /^\d+\.\d+\.\d+$/u;

export function releaseManifest(pkg) {
  const { devDependencies: _devDependencies, ...rest } = pkg;
  return rest;
}

export function pinnedNpmVersion(pkg) {
  const pin = pkg.dependencies?.npm;
  if (typeof pin !== "string" || !EXACT_VERSION.test(pin)) {
    throw new Error(
      `Expected an exact npm pin in dependencies.npm, found ${JSON.stringify(pin)}`,
    );
  }
  return pin;
}

export function assertNpmVersion(actual, expected) {
  if (actual !== expected) {
    throw new Error(
      `npm ${actual} is running but the release pins npm ${expected}; install the pinned npm first`,
    );
  }
}

export function assertPackListing(paths, { requireShrinkwrap = true } = {}) {
  if (paths.includes(PACKAGE_LOCK)) {
    throw new Error(`The package listing must not contain ${PACKAGE_LOCK}`);
  }
  if (requireShrinkwrap && !paths.includes(SHRINKWRAP)) {
    throw new Error(`The package listing is missing ${SHRINKWRAP}`);
  }
}

async function run(command, args, cwd) {
  try {
    const { stdout } = await execFileAsync(command, args, {
      cwd,
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    const stderr = typeof error?.stderr === "string" ? error.stderr.trim() : "";
    throw new Error(
      `${command} ${args.join(" ")} failed: ${error?.message ?? error}${stderr ? `\n${stderr}` : ""}`,
      { cause: error },
    );
  }
}

async function resolveLock({ npmCommand, packageRoot }) {
  const pkg = JSON.parse(
    await readFile(join(packageRoot, "package.json"), "utf8"),
  );
  const expected = pinnedNpmVersion(pkg);
  assertNpmVersion(
    (await run(npmCommand, ["--version"], packageRoot)).trim(),
    expected,
  );

  const scratch = await mkdtemp(join(tmpdir(), "bb-release-lock-"));
  try {
    const packed = JSON.parse(
      await run(
        npmCommand,
        ["pack", "--json", "--ignore-scripts", "--pack-destination", scratch],
        packageRoot,
      ),
    );
    if (!Array.isArray(packed) || packed.length !== 1) {
      throw new Error("Unexpected npm pack output");
    }
    const [entry] = packed;
    const listing = entry.files.map((file) => file.path);

    const extractDir = join(scratch, "extract");
    await run("mkdir", ["-p", extractDir], scratch);
    await run(
      "tar",
      [
        "-xzf",
        join(scratch, entry.filename),
        "-C",
        extractDir,
        "package/package.json",
      ],
      scratch,
    );
    const workDir = join(extractDir, "package");
    const packedManifest = JSON.parse(
      await readFile(join(workDir, "package.json"), "utf8"),
    );
    await writeFile(
      join(workDir, "package.json"),
      `${JSON.stringify(releaseManifest(packedManifest), null, 2)}\n`,
    );
    await run(
      npmCommand,
      [
        "install",
        "--package-lock-only",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
      ],
      workDir,
    );
    await run(npmCommand, ["shrinkwrap"], workDir);
    return {
      listing,
      lock: await readFile(join(workDir, SHRINKWRAP)),
    };
  } finally {
    await rm(scratch, { force: true, recursive: true });
  }
}

function withDefaults(options = {}) {
  return {
    npmCommand: options.npmCommand ?? "npm",
    packageRoot: resolve(
      options.packageRoot ??
        join(dirname(fileURLToPath(import.meta.url)), ".."),
    ),
  };
}

export async function generateLock(options) {
  const resolved = withDefaults(options);
  const { listing, lock } = await resolveLock(resolved);
  assertPackListing(listing, { requireShrinkwrap: false });
  await writeFile(join(resolved.packageRoot, SHRINKWRAP), lock);
}

export async function checkLock(options) {
  const resolved = withDefaults(options);
  let committed;
  try {
    committed = await readFile(join(resolved.packageRoot, SHRINKWRAP));
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(
        `${SHRINKWRAP} is missing; run "node scripts/release-lock.mjs generate" and commit it`,
        { cause: error },
      );
    }
    throw error;
  }
  const { listing, lock } = await resolveLock(resolved);
  assertPackListing(listing);
  if (!lock.equals(committed)) {
    throw new Error(
      `${SHRINKWRAP} is out of date with package.json; run "node scripts/release-lock.mjs generate" and commit the result`,
    );
  }
}

function parseArgs(argv) {
  const [mode, ...rest] = argv;
  if (mode !== "generate" && mode !== "check") {
    throw new Error(
      "Usage: release-lock.mjs generate|check [--package-root DIR]",
    );
  }
  const options = { mode };
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (value === undefined || value === "") {
      throw new Error(`${flag} requires a value`);
    }
    if (flag === "--package-root") options.packageRoot = value;
    else throw new Error(`Unknown argument ${flag}`);
  }
  return options;
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const { mode, ...options } = parseArgs(process.argv.slice(2));
    if (mode === "generate") await generateLock(options);
    else await checkLock(options);
    process.stdout.write(
      mode === "generate"
        ? `release-lock: wrote ${SHRINKWRAP}\n`
        : `release-lock: ${SHRINKWRAP} is up to date\n`,
    );
  } catch (error) {
    process.stderr.write(`release-lock: ${error?.message ?? error}\n`);
    process.exitCode = 1;
  }
}
