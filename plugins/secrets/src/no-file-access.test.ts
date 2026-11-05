import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(here, "..");

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "node_modules" ? [] : sources(full);
    }
    return /\.(ts|tsx)$/u.test(entry.name) && !/\.test\.tsx?$/u.test(entry.name)
      ? [full]
      : [];
  });
}

describe("allowlisted paths are never opened by the plugin (T1.7)", () => {
  const files = [
    ...sources(path.join(pluginRoot, "src")),
    path.join(pluginRoot, "app.tsx"),
  ].filter((file) => !file.endsWith("dotenv.ts"));

  it("finds the plugin sources", () => {
    expect(files.length).toBeGreaterThan(3);
  });

  it.each(files)(
    "%s makes no filesystem or file-area read or write",
    (file) => {
      const text = readFileSync(file, "utf8");
      expect(text).not.toMatch(/from\s+["'](?:node:)?fs(?:\/promises)?["']/u);
      expect(text).not.toMatch(/require\(\s*["'](?:node:)?fs/u);
      expect(text).not.toMatch(
        /sdk\.files\.(?:read|write|list|stat|delete)\b/u,
      );
    },
  );
});
