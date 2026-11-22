import { readFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import type { PluginFrozenLockfile } from "@bb/server-contract";
import { join } from "node:path";
import { runInstallCommand } from "./install-sources.js";

export async function installGitDependencies(
  rootDir: string,
  frozenLockfile?: PluginFrozenLockfile,
): Promise<void> {
  let lockPath: string | undefined;
  if (frozenLockfile !== undefined) {
    for (const name of ["npm-shrinkwrap.json", "package-lock.json"]) {
      const candidate = join(rootDir, name);
      try {
        const bytes = await readFile(candidate);
        if (
          createHash("sha256").update(bytes).digest("hex") !==
          frozenLockfile.sha256
        )
          throw new Error("frozen lockfile digest mismatch");
        lockPath = candidate;
        break;
      } catch (error) {
        if (
          !(
            error instanceof Error &&
            "code" in error &&
            error.code === "ENOENT"
          )
        )
          throw error;
      }
    }
    if (lockPath === undefined)
      throw new Error("frozen install requires a readable lockfile");
  }
  for (const name of [".npmrc", ".yarnrc", ".yarnrc.yml"]) {
    await rm(join(rootDir, name), { force: true });
  }
  await runInstallCommand("npm", [
    frozenLockfile === undefined ? "install" : "ci",
    "--prefix",
    rootDir,
    "--ignore-scripts",
    "--omit=dev",
    "--omit=optional",
    "--no-audit",
    "--no-fund",
  ]);
  if (
    frozenLockfile !== undefined &&
    lockPath !== undefined &&
    createHash("sha256")
      .update(await readFile(lockPath))
      .digest("hex") !== frozenLockfile.sha256
  )
    throw new Error("frozen lockfile changed during install");
}
