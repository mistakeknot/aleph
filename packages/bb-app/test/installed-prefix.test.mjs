import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  parseSmokeArgs,
  resolveInstalledPrefix,
} from "../scripts/installed-prefix.mjs";

const BINS = {
  "bb-app": "dist/bb-app.js",
  bb: "dist/bb.js",
  "bb-server": "dist/bb-server.js",
  "bb-host-daemon": "dist/bb-host-daemon.js",
};

async function makePrefix(root, { bins = BINS, name = "bb-app" } = {}) {
  const packageDir = join(root, "lib", "node_modules", "bb-app");
  await mkdir(join(packageDir, "dist"), { recursive: true });
  await writeFile(
    join(packageDir, "package.json"),
    JSON.stringify({ name, version: "1.0.0", bin: BINS }),
  );
  await mkdir(join(root, "bin"), { recursive: true });
  for (const [bin, target] of Object.entries(bins)) {
    await writeFile(join(packageDir, target), "#!/usr/bin/env node\n");
    await symlink(
      join("..", "lib", "node_modules", "bb-app", target),
      join(root, "bin", bin),
    );
  }
  return packageDir;
}

describe("parseSmokeArgs", () => {
  it("defaults to the packed-tarball flow", () => {
    expect(parseSmokeArgs([])).toEqual({ installedPrefix: null });
  });

  it("accepts the prefix as a separate value or with an equals sign", () => {
    expect(parseSmokeArgs(["--installed-prefix", "/some/prefix"])).toEqual({
      installedPrefix: "/some/prefix",
    });
    expect(parseSmokeArgs(["--installed-prefix=/other"])).toEqual({
      installedPrefix: "/other",
    });
  });

  it("rejects a missing value and unknown arguments", () => {
    expect(() => parseSmokeArgs(["--installed-prefix"])).toThrow(/requires/u);
    expect(() => parseSmokeArgs(["--installed-prefix="])).toThrow(/requires/u);
    expect(() => parseSmokeArgs(["--bogus"])).toThrow(/Unknown argument/u);
  });
});

describe("resolveInstalledPrefix", () => {
  let root;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "bb-installed-prefix-test-"));
  });
  afterEach(async () => {
    await rm(root, { force: true, recursive: true });
  });

  it("locates the bin directory and installed package under a prefix", async () => {
    const packageDir = await makePrefix(root);
    expect(resolveInstalledPrefix(root)).toEqual({
      binDir: join(root, "bin"),
      packageDir,
    });
  });

  it("follows a symlinked package directory", async () => {
    const real = await makePrefix(join(root, "real"));
    await mkdir(join(root, "lib", "node_modules"), { recursive: true });
    await symlink(real, join(root, "lib", "node_modules", "bb-app"));
    await mkdir(join(root, "bin"), { recursive: true });
    for (const [bin, target] of Object.entries(BINS)) {
      await symlink(join(real, target), join(root, "bin", bin));
    }
    expect(resolveInstalledPrefix(root).packageDir).toBe(
      join(root, "lib", "node_modules", "bb-app"),
    );
  });

  it("fails when the package is missing", () => {
    expect(() => resolveInstalledPrefix(root)).toThrow(/bb-app/u);
  });

  it("fails when the package has a different name", async () => {
    await makePrefix(root, { name: "something-else" });
    expect(() => resolveInstalledPrefix(root)).toThrow(/something-else/u);
  });

  it("fails when a declared bin link is missing", async () => {
    await makePrefix(root, {
      bins: { "bb-app": BINS["bb-app"], bb: BINS.bb },
    });
    expect(() => resolveInstalledPrefix(root)).toThrow(/bb-server/u);
  });
});
