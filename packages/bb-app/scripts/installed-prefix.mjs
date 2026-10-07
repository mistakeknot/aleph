import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const PACKAGE_NAME = "bb-app";

export function parseSmokeArgs(argv) {
  let installedPrefix = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--installed-prefix") {
      installedPrefix = argv[index + 1] ?? "";
      index += 1;
    } else if (arg.startsWith("--installed-prefix=")) {
      installedPrefix = arg.slice("--installed-prefix=".length);
    } else {
      throw new Error(`Unknown argument ${arg}`);
    }
    if (installedPrefix === "") {
      throw new Error("--installed-prefix requires a directory");
    }
  }
  return { installedPrefix };
}

export function resolveInstalledPrefix(prefix) {
  const root = resolve(prefix);
  const binDir = join(root, "bin");
  const packageDir = join(root, "lib", "node_modules", PACKAGE_NAME);
  const manifestPath = join(packageDir, "package.json");
  if (!existsSync(manifestPath)) {
    throw new Error(`No installed ${PACKAGE_NAME} found at ${packageDir}`);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.name !== PACKAGE_NAME) {
    throw new Error(
      `Expected ${PACKAGE_NAME} at ${packageDir} but found ${manifest.name}`,
    );
  }
  for (const bin of Object.keys(manifest.bin ?? {})) {
    if (!existsSync(join(binDir, bin))) {
      throw new Error(
        `Installed ${PACKAGE_NAME} is missing its ${bin} link in ${binDir}`,
      );
    }
  }
  return { binDir, packageDir };
}
