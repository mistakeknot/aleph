import { readdir, readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const desktopPackageRoot = process.cwd();
const upstreamFeedPattern =
  /get-bb\/bb\/releases|get-bb\/bb\b.*desktop-(latest|nightly)/u;
const scannedDirectories = ["src", "scripts"];
const scannedFiles = ["electron-builder.config.json", "package.json"];
const scannedExtensions = /\.(?:ts|tsx|mts|mjs|cjs|js|json)$/u;

async function listFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        return listFiles(path);
      }
      return scannedExtensions.test(entry.name) ? [path] : [];
    }),
  );
  return nested.flat();
}

describe("desktop app has no upstream get-bb update feed", () => {
  it("references no get-bb release URL in shipped desktop sources or config", async () => {
    const files = [
      ...(
        await Promise.all(
          scannedDirectories.map((directory) =>
            listFiles(resolve(desktopPackageRoot, directory)),
          ),
        )
      ).flat(),
      ...scannedFiles.map((file) => resolve(desktopPackageRoot, file)),
    ];
    const offenders: string[] = [];
    for (const file of files) {
      const text = await readFile(file, "utf8");
      if (upstreamFeedPattern.test(text)) {
        offenders.push(relative(desktopPackageRoot, file));
      }
    }

    expect(files.length).toBeGreaterThan(10);
    expect(offenders).toEqual([]);
  });

  it("never publishes from the desktop build scripts", async () => {
    const packageJson: { scripts: Record<string, string> } = JSON.parse(
      await readFile(resolve(desktopPackageRoot, "package.json"), "utf8"),
    );

    for (const [name, command] of Object.entries(packageJson.scripts)) {
      expect(command, name).not.toMatch(/--publish\s+always/u);
    }
    expect(packageJson.scripts["desktop:build"]).toContain("--publish never");
  });
});
