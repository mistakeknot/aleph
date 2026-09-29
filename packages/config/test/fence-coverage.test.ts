import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);
const SOURCE_ROOTS = ["apps", "packages", "plugins"];
const SKIPPED_SEGMENTS = new Set([
  "node_modules",
  "dist",
  "generated",
  "test",
  "tests",
  "__tests__",
  "scripts",
  "testing",
  ".turbo",
]);
const RAW_OPEN_PATTERN =
  /new Database\(|new DatabaseSync\(|createConnection\(/u;
const FENCE_GUARD_PATTERN =
  /assertFenceAllowsDatabase|assertFenceAllowsDataDir|runLaunchGuard/u;

interface RawOpener {
  file: string;
  source: string;
}

function collectSources(dir: string, into: RawOpener[]): void {
  for (const name of readdirSync(dir)) {
    if (SKIPPED_SEGMENTS.has(name)) continue;
    const path = join(dir, name);
    const stats = statSync(path);
    if (stats.isDirectory()) {
      collectSources(path, into);
      continue;
    }
    if (!/\.(ts|tsx)$/u.test(name) || /\.test\./u.test(name)) continue;
    const source = readFileSync(path, "utf8");
    if (RAW_OPEN_PATTERN.test(source)) {
      into.push({ file: relative(repoRoot, path), source });
    }
  }
}

const ALLOWED_UNGUARDED = new Set([
  "apps/desktop/src/browser-import/cookie-database.ts",
  "apps/desktop/src/desktop-browser-cdp.ts",
  "packages/bb-app/src/app-update/npm-revision.ts",
  "packages/plugin-sdk/src/testing/fake-plugin-host.ts",
  "packages/provider-bridge-acp/src/bridge/opencode-usage.ts",
  "packages/provider-bridge-acp/src/bridge/provider-maintenance.ts",
  "packages/provider-bridge-acp/src/bridge/tool-proxy-mcp.ts",
]);

describe("maintenance fence coverage", () => {
  const openers: RawOpener[] = [];
  for (const root of SOURCE_ROOTS)
    collectSources(join(repoRoot, root), openers);

  it("finds the known Aleph data database openers", () => {
    const files = openers.map((entry) => entry.file);
    expect(files).toContain("packages/db/src/connection.ts");
    expect(files).toContain("apps/server/src/db.ts");
  });

  it("guards every production database open that touches Aleph data", () => {
    const unguarded = openers
      .filter((entry) => !FENCE_GUARD_PATTERN.test(entry.source))
      .map((entry) => entry.file)
      .filter(
        (file) =>
          !ALLOWED_UNGUARDED.has(file) && file !== "apps/server/src/db.ts",
      );
    expect(unguarded).toEqual([]);
  });

  it("routes the core database opener through createConnection", () => {
    const db = readFileSync(join(repoRoot, "apps/server/src/db.ts"), "utf8");
    expect(db).toContain("createConnection(");
    const connection = readFileSync(
      join(repoRoot, "packages/db/src/connection.ts"),
      "utf8",
    );
    expect(connection).toContain("assertFenceAllowsDatabase(");
  });
});

describe("launch entry coverage", () => {
  const ENTRIES = [
    "apps/server/src/index.ts",
    "apps/host-daemon/src/index.ts",
    "apps/desktop/src/main.ts",
    "apps/cli/src/launch-fence.ts",
  ];
  it.each(ENTRIES)("%s runs the launch guard", (entry) => {
    expect(readFileSync(join(repoRoot, entry), "utf8")).toContain(
      "runLaunchGuard(",
    );
  });

  it("runs the CLI launch guard from the CLI entry", () => {
    expect(
      readFileSync(join(repoRoot, "apps/cli/src/index.ts"), "utf8"),
    ).toContain("guardCliLaunch()");
  });
});
