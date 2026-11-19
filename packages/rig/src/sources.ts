import { execFile } from "node:child_process";
import { constants } from "node:fs";
import {
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import type { Rig } from "./index.js";
const exec = promisify(execFile);
type Source = Rig["plugins"][number]["source"];
export async function contained(root: string, path: string): Promise<string> {
  const actual = await realpath(path);
  const rel = relative(await realpath(root), actual);
  if (rel.startsWith("..") || isAbsolute(rel))
    throw new Error("Source escapes its root");
  return actual;
}
async function run(
  command: string,
  args: string[],
  cwd: string,
): Promise<string> {
  try {
    const result = await exec(command, args, {
      cwd,
      timeout: 120_000,
      maxBuffer: 2 * 1024 * 1024,
      env: {
        PATH: process.env.PATH,
        HOME: cwd,
        TMPDIR: cwd,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
        GIT_ALLOW_PROTOCOL: "https",
        npm_config_ignore_scripts: "true",
        npm_config_userconfig: "/dev/null",
      },
    });
    return result.stdout;
  } catch {
    throw new Error("Source preparation failed; process output suppressed");
  }
}
async function checkTree(root: string): Promise<void> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const path = join(root, entry.name);
    const info = await lstat(path);
    if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile()))
      throw new Error("Source special files refused");
    if (info.isDirectory()) await checkTree(path);
    else {
      if (
        /^(?:\.env(?:\..*)?|\.npmrc|auth\.json|credentials(?:\..*)?)$/iu.test(
          entry.name,
        )
      )
        throw new Error("Credential-bearing source file refused");
      if (info.size > 8 * 1024 * 1024)
        throw new Error("Source file exceeds inspection limit");
      const body = await readFile(path, "utf8");
      if (
        /(?:\bBearer\s+\S+|\b(?:sk|ghp|gho|github_pat|xox[baprs])[-_][A-Za-z0-9_-]+|-----BEGIN.*PRIVATE KEY|(?:password|accessToken|refreshToken|apiKey|api_key)\s*[=:]\s*["']?[A-Za-z0-9_-]+)/iu.test(
          body,
        )
      )
        throw new Error("Secret-like source content refused");
    }
  }
}
export async function prepareSource(
  source: Source,
  args: { rigDir: string; destination: string; builtinRoot?: string },
): Promise<string> {
  await mkdir(dirname(args.destination), { recursive: true });
  if ("builtin" in source) {
    if (!args.builtinRoot) throw new Error("Builtin source root required");
    return contained(args.builtinRoot, join(args.builtinRoot, source.builtin));
  }
  if ("path" in source) {
    const root = await contained(
      args.rigDir,
      resolve(args.rigDir, source.path),
    );
    const rel = relative(root, resolve(args.destination));
    if (!rel.startsWith("..") && !isAbsolute(rel))
      throw new Error("Destination cannot be inside source");
    await checkTree(root);
    await cp(root, args.destination, {
      recursive: true,
      force: false,
      errorOnExist: true,
      filter: (path) => !/[\\/](?:node_modules|\.git)(?:[\\/]|$)/u.test(path),
    });
    return args.destination;
  }
  await mkdir(args.destination, { recursive: true });
  if ("git" in source) {
    await run("git", ["init", "--quiet"], args.destination);
    await run(
      "git",
      ["fetch", "--depth=1", source.git, source.ref],
      args.destination,
    );
    await run(
      "git",
      ["checkout", "--detach", "--quiet", source.ref],
      args.destination,
    );
    const root = await contained(
      args.destination,
      join(args.destination, source.subdir),
    );
    await checkTree(root);
    return root;
  }
  const packed = await run(
    "npm",
    ["pack", "--ignore-scripts", "--json", `${source.npm}@${source.version}`],
    args.destination,
  );
  const parsed: unknown = JSON.parse(packed);
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 1 ||
    !parsed[0] ||
    typeof parsed[0] !== "object" ||
    !("filename" in parsed[0]) ||
    typeof parsed[0].filename !== "string" ||
    !/^[A-Za-z0-9._-]+\.tgz$/u.test(parsed[0].filename)
  )
    throw new Error("Invalid package response");
  const archive = parsed[0].filename;
  const entries = await run("tar", ["-tvzf", archive], args.destination);
  if (
    entries
      .split("\n")
      .filter(Boolean)
      .some((line) => !/^[-d]/u.test(line))
  )
    throw new Error("Package special files refused");
  const names = await run("tar", ["-tzf", archive], args.destination);
  if (
    names
      .split("\n")
      .filter(Boolean)
      .some(
        (path) =>
          !path.startsWith("package/") || path.split("/").includes(".."),
      )
  )
    throw new Error("Package paths refused");
  await run(
    "tar",
    ["-xzf", archive, "--no-same-owner", "--no-same-permissions"],
    args.destination,
  );
  const root = join(args.destination, "package");
  await checkTree(root);
  return root;
}
export async function sourceManifest(
  root: string,
): Promise<{ name: string; version: string }> {
  try {
    const manifest: unknown = JSON.parse(
      await readFile(join(root, "package.json"), "utf8"),
    );
    if (
      !manifest ||
      typeof manifest !== "object" ||
      !("name" in manifest) ||
      !("version" in manifest) ||
      typeof manifest.name !== "string" ||
      typeof manifest.version !== "string"
    )
      throw new Error();
    return { name: manifest.name, version: manifest.version };
  } catch {
    throw new Error("Invalid source manifest; values suppressed");
  }
}
export async function copySkill(
  root: string,
  destination: string,
): Promise<void> {
  await checkTree(root);
  await mkdir(dirname(destination), { recursive: true });
  await cp(root, destination, {
    recursive: true,
    mode: constants.COPYFILE_EXCL,
    errorOnExist: true,
    force: false,
    filter: (path) => !/[\\/](?:node_modules|\.git)(?:[\\/]|$)/u.test(path),
  });
}

export async function prepareDependencies(root: string): Promise<void> {
  const manifest: unknown = JSON.parse(
    await readFile(join(root, "package.json"), "utf8"),
  );
  if (
    manifest &&
    typeof manifest === "object" &&
    "dependencies" in manifest &&
    manifest.dependencies &&
    typeof manifest.dependencies === "object" &&
    Object.keys(manifest.dependencies).length
  ) {
    await run(
      "npm",
      ["install", "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund"],
      root,
    );
  }
}

export async function treeDigest(root: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  const hash = createHash("sha256");
  async function visit(dir: string, prefix: string): Promise<void> {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort(
      (a, b) => a.name.localeCompare(b.name),
    )) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const path = join(dir, entry.name);
      const rel = `${prefix}/${entry.name}`;
      if (entry.isSymbolicLink()) {
        hash.update(`link:${rel}`);
        continue;
      }
      if (entry.isDirectory()) await visit(path, rel);
      else if (entry.isFile()) {
        hash.update(`file:${rel}\0`);
        hash.update(await readFile(path));
        hash.update("\0");
      }
    }
  }
  await visit(root, "");
  return hash.digest("hex");
}
