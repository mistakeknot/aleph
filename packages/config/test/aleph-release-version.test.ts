import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const ALEPH_RELEASE_VERSION =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\+aleph\.\d+$/u;

function readRepoFile(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

function readPackageVersion(relativePath: string): string {
  const packageJson: unknown = JSON.parse(readRepoFile(relativePath));
  if (
    typeof packageJson !== "object" ||
    packageJson === null ||
    !("version" in packageJson) ||
    typeof packageJson.version !== "string"
  ) {
    throw new Error(`Missing string version field in ${relativePath}.`);
  }
  return packageJson.version;
}

describe("Aleph release version", () => {
  it.each([
    ["bb-app", "../../bb-app/package.json"],
    ["@bb/desktop", "../../../apps/desktop/package.json"],
  ])("gives %s an +aleph.<n> version", (_name, relativePath) => {
    expect(readPackageVersion(relativePath)).toMatch(ALEPH_RELEASE_VERSION);
  });

  it("gives the newest changelog release an +aleph.<n> version", () => {
    const metadata = readRepoFile("../../../changelog-metadata.ts");
    const newestRelease = /RELEASE_META[^{]*\{\s*"([^"]+)"/u.exec(
      metadata,
    )?.[1];
    expect(newestRelease).toMatch(ALEPH_RELEASE_VERSION);
  });
});
