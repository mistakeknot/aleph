import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const testDir = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(testDir, "../../..");

function readText(...segments: string[]): string {
  return readFileSync(resolve(workspaceRoot, ...segments), "utf8");
}

interface ManifestWithDependencies {
  dependencies?: Record<string, string>;
}

function dependencyVersion(...segments: string[]): string | undefined {
  const manifest = JSON.parse(
    readText(...segments),
  ) as ManifestWithDependencies;
  return manifest.dependencies?.["better-sqlite3"];
}

function extractStringList(source: string, marker: string): string[] {
  const start = source.indexOf(marker);
  expect(start).toBeGreaterThanOrEqual(0);
  const open = source.indexOf("[", start);
  const close = source.indexOf("]", open);
  return [...source.slice(open, close).matchAll(/"([^"]+)"/gu)].map(
    (match) => match[1] ?? "",
  );
}

describe("better-sqlite3 host pin", () => {
  const bbAppPin = dependencyVersion("packages", "bb-app", "package.json");

  it("pins an exact bb-app version", () => {
    expect(bbAppPin).toMatch(/^\d+\.\d+\.\d+$/u);
  });

  it("matches the host daemon dependency to the bb-app pin", () => {
    expect(dependencyVersion("apps", "host-daemon", "package.json")).toBe(
      bbAppPin,
    );
  });

  it("matches the session-search dependency to the bb-app pin", () => {
    expect(
      dependencyVersion("packages", "session-search", "package.json"),
    ).toBe(bbAppPin);
  });

  it("matches the bb-app shrinkwrap entry to the bb-app pin", () => {
    const shrinkwrap = JSON.parse(
      readText("packages", "bb-app", "npm-shrinkwrap.json"),
    ) as { packages: Record<string, { version?: string }> };

    expect(shrinkwrap.packages["node_modules/better-sqlite3"]?.version).toBe(
      bbAppPin,
    );
  });

  it("lists better-sqlite3 in both host artifact dependency lists", () => {
    const buildHost = extractStringList(
      readText("packages", "bb-app", "scripts", "build-host.mjs"),
      "const dependencyNames",
    );
    const artifact = extractStringList(
      readText(
        "apps",
        "server",
        "src",
        "services",
        "install",
        "bb-app-artifact.ts",
      ),
      "const HOST_DEPENDENCIES",
    );

    expect(buildHost).toContain("better-sqlite3");
    expect(artifact).toContain("better-sqlite3");
    expect(artifact).toEqual(buildHost);
  });

  it("keeps better-sqlite3 external to the host bundle", () => {
    expect(readText("scripts", "build-utils.mjs")).toContain(
      '"better-sqlite3"',
    );
  });

  it("exercises FTS5 in the installed native module check", () => {
    const source = readText(
      "packages",
      "bb-app",
      "src",
      "app-update",
      "npm-revision.ts",
    );

    expect(source).toContain("require('better-sqlite3')");
    expect(source).toContain("USING fts5");
  });
});
