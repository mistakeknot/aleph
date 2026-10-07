import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertNpmVersion,
  assertPackListing,
  checkLock,
  generateLock,
  pinnedNpmVersion,
  releaseManifest,
} from "../scripts/release-lock.mjs";

let npmVersion;

const RESOLUTION_TIMEOUT_MS = 60_000;

describe("releaseManifest", () => {
  it("drops devDependencies and keeps everything else", () => {
    const pkg = {
      name: "demo",
      version: "1.0.0",
      dependencies: { zod: "4.3.6" },
      devDependencies: { "@scope/internal": "workspace:*" },
      scripts: { build: "true" },
    };
    const manifest = releaseManifest(pkg);
    expect(manifest).toEqual({
      name: "demo",
      version: "1.0.0",
      dependencies: { zod: "4.3.6" },
      scripts: { build: "true" },
    });
    expect(pkg.devDependencies).toBeDefined();
  });
});

describe("pinnedNpmVersion", () => {
  it("reads the exact npm pin from the package manifest", () => {
    expect(pinnedNpmVersion({ dependencies: { npm: "11.16.0" } })).toBe(
      "11.16.0",
    );
  });

  it("refuses a missing or ranged pin", () => {
    expect(() => pinnedNpmVersion({ dependencies: {} })).toThrow(/pin/u);
    expect(() =>
      pinnedNpmVersion({ dependencies: { npm: "^11.0.0" } }),
    ).toThrow(/pin/u);
  });

  it("matches the pin in the real bb-app manifest", async () => {
    const pkg = JSON.parse(
      await readFile(join(__dirname, "..", "package.json"), "utf8"),
    );
    expect(pinnedNpmVersion(pkg)).toMatch(/^\d+\.\d+\.\d+$/u);
  });
});

describe("assertNpmVersion", () => {
  it("passes on equality and fails on any difference", () => {
    expect(() => assertNpmVersion("11.16.0", "11.16.0")).not.toThrow();
    expect(() => assertNpmVersion("11.15.0", "11.16.0")).toThrow(
      /11\.15\.0.*11\.16\.0/u,
    );
  });
});

describe("assertPackListing", () => {
  it("requires the shrinkwrap and rejects a package-lock.json", () => {
    expect(() =>
      assertPackListing(["package.json", "npm-shrinkwrap.json"]),
    ).not.toThrow();
    expect(() => assertPackListing(["package.json"])).toThrow(
      /npm-shrinkwrap\.json/u,
    );
    expect(() =>
      assertPackListing(["package.json", "package-lock.json"], {
        requireShrinkwrap: false,
      }),
    ).toThrow(/package-lock\.json/u);
    expect(() =>
      assertPackListing(["package.json"], { requireShrinkwrap: false }),
    ).not.toThrow();
  });
});

describe(
  "generate and check on a standalone package",
  { timeout: RESOLUTION_TIMEOUT_MS },
  () => {
    let root;
    let packageRoot;

    async function writePackage(overrides = {}) {
      const manifest = {
        name: "release-lock-fixture",
        version: "1.2.3",
        files: ["index.js", "npm-shrinkwrap.json"],
        dependencies: { npm: npmVersion },
        devDependencies: { "@fixture/internal": "workspace:*" },
        ...overrides,
      };
      await writeFile(
        join(packageRoot, "package.json"),
        `${JSON.stringify(manifest, null, 2)}\n`,
      );
    }

    const options = () => ({ packageRoot });

    beforeEach(async () => {
      root = await mkdtemp(join(tmpdir(), "bb-release-lock-test-"));
      packageRoot = join(root, "pkg");
      await mkdir(packageRoot);
      await writeFile(join(packageRoot, "index.js"), "module.exports = 1;\n");
      npmVersion = execFileSync("npm", ["--version"], {
        cwd: root,
        encoding: "utf8",
      }).trim();
      await writePackage();
    });
    afterEach(async () => {
      await rm(root, { force: true, recursive: true });
    });

    it("writes a committed shrinkwrap without devDependencies", async () => {
      await generateLock(options());
      const lock = JSON.parse(
        await readFile(join(packageRoot, "npm-shrinkwrap.json"), "utf8"),
      );
      expect(lock.name).toBe("release-lock-fixture");
      expect(JSON.stringify(lock)).not.toContain("@fixture/internal");
    });

    it("passes check right after generate, and generate is repeatable", async () => {
      await generateLock(options());
      const first = await readFile(join(packageRoot, "npm-shrinkwrap.json"));
      await expect(checkLock(options())).resolves.toBeUndefined();
      await generateLock(options());
      const second = await readFile(join(packageRoot, "npm-shrinkwrap.json"));
      expect(second.equals(first)).toBe(true);
    });

    it("fails check when the manifest drifts from the shrinkwrap", async () => {
      await generateLock(options());
      await writePackage({ version: "1.2.4" });
      await expect(checkLock(options())).rejects.toThrow(/out of date/u);
    });

    it("fails check when the shrinkwrap is edited or absent", async () => {
      await generateLock(options());
      const lockPath = join(packageRoot, "npm-shrinkwrap.json");
      const text = await readFile(lockPath, "utf8");
      await writeFile(lockPath, text.replace("1.2.3", "9.9.9"));
      await expect(checkLock(options())).rejects.toThrow(/out of date/u);
      await rm(lockPath);
      await expect(checkLock(options())).rejects.toThrow(
        /npm-shrinkwrap\.json/u,
      );
    });

    it("refuses to run under an npm other than the manifest pin", async () => {
      await writePackage({ dependencies: { npm: "10.9.0" } });
      await expect(generateLock(options())).rejects.toThrow(
        /pins npm 10\.9\.0/u,
      );
      await expect(checkLock(options())).rejects.toThrow(/npm-shrinkwrap/u);
      await expect(
        readFile(join(packageRoot, "npm-shrinkwrap.json")),
      ).rejects.toThrow();
    });

    it("does not let an override authorize a different npm", async () => {
      await writePackage({ dependencies: { npm: "10.9.0" } });
      await expect(
        generateLock({ ...options(), expectedNpmVersion: npmVersion }),
      ).rejects.toThrow(/pins npm 10\.9\.0/u);
      await expect(
        readFile(join(packageRoot, "npm-shrinkwrap.json")),
      ).rejects.toThrow();
    });

    it("rejects a missing or ranged manifest pin", async () => {
      await writePackage({ dependencies: { npm: "^11.0.0" } });
      await expect(generateLock(options())).rejects.toThrow(/pin/u);
      await writePackage({ dependencies: {} });
      await expect(generateLock(options())).rejects.toThrow(/pin/u);
    });

    it("leaves no package-lock.json behind in the package", async () => {
      await generateLock(options());
      await expect(
        readFile(join(packageRoot, "package-lock.json")),
      ).rejects.toThrow();
    });

    it("packs the shrinkwrap and never a package-lock.json", async () => {
      await generateLock(options());
      const [packed] = JSON.parse(
        execFileSync(
          "npm",
          ["pack", "--dry-run", "--json", "--ignore-scripts"],
          {
            cwd: packageRoot,
            encoding: "utf8",
          },
        ),
      );
      const paths = packed.files.map((file) => file.path);
      expect(paths).toContain("npm-shrinkwrap.json");
      expect(paths).not.toContain("package-lock.json");
    });
  },
);
