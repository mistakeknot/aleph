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
const SOURCE_ROOTS = ["apps", "packages", "plugins", "scripts"];
const SCANNED_EXTENSION_PATTERN = /\.(ts|tsx|mjs|cjs|js)$/u;
const SKIPPED_SEGMENTS = new Set([
  "node_modules",
  "dist",
  "generated",
  "test",
  "tests",
  "__tests__",
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
    if (!SCANNED_EXTENSION_PATTERN.test(name) || /\.test\./u.test(name))
      continue;
    const source = readFileSync(path, "utf8");
    if (RAW_OPEN_PATTERN.test(source)) {
      into.push({ file: relative(repoRoot, path), source });
    }
  }
}

const ALLOWED_UNGUARDED = new Map<string, string>([
  [
    "apps/desktop/src/browser-import/cookie-database.ts",
    "reads a copy of a third-party browser cookie database",
  ],
  [
    "apps/desktop/src/desktop-browser-cdp.ts",
    "opens no Aleph data; browser automation helper",
  ],
  [
    "packages/bb-app/src/app-update/npm-revision.ts",
    "reads the installed npm package cache, not the Aleph data dir",
  ],
  [
    "packages/provider-bridge-acp/src/bridge/opencode-usage.ts",
    "reads the third-party opencode usage database read-only",
  ],
  [
    "packages/provider-bridge-acp/src/bridge/provider-maintenance.ts",
    "operates on provider-owned databases, not the Aleph data dir",
  ],
  [
    "packages/provider-bridge-acp/src/bridge/tool-proxy-mcp.ts",
    "provider tool proxy over provider-owned state",
  ],
  [
    "apps/server/scripts/benchmark-completed-event-output-migration.mjs",
    "developer benchmark on a caller-supplied scratch path; createConnection enforces the fence backstop",
  ],
  [
    "apps/server/scripts/benchmark-conversation-outline.ts",
    "developer benchmark on a caller-supplied scratch path; createConnection enforces the fence backstop",
  ],
  [
    "packages/scripts/src/commands/seed-perf-db.ts",
    "developer seeding command; opens through createConnection, which enforces the fence backstop",
  ],
  [
    "packages/scripts/src/lib/aleph-migration-record.ts",
    "migration recording tool; opens through createConnection, which enforces the fence backstop",
  ],
  [
    "apps/desktop/scripts/prepare-native-modules.cjs",
    "build-time smoke test against an in-memory database",
  ],
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

  it("scans scripts and non-TypeScript sources", () => {
    const files = openers.map((entry) => entry.file);
    expect(files).toContain(
      "apps/server/scripts/benchmark-completed-event-output-migration.mjs",
    );
  });

  it("keeps the unguarded allowlist free of stale entries", () => {
    const files = new Set(openers.map((entry) => entry.file));
    const stale = [...ALLOWED_UNGUARDED.keys()].filter(
      (file) => !files.has(file),
    );
    expect(stale).toEqual([]);
  });

  it("guards or allowlists every scanned raw database open outside test files", () => {
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
    const source = readFileSync(join(repoRoot, entry), "utf8");
    expect(source).toMatch(/runLaunchGuard\(|exitOnLaunchRefusal\(/u);
  });

  it.each(["apps/server/src/index.ts", "apps/host-daemon/src/index.ts"])(
    "%s guards the launch before installing diagnostics",
    (entry) => {
      const source = readFileSync(join(repoRoot, entry), "utf8");
      const guard = source.indexOf("exitOnLaunchRefusal({");
      const diagnostics = source.indexOf("installSafeProcessDiagnostics(");
      expect(guard).toBeGreaterThan(-1);
      expect(diagnostics).toBeGreaterThan(guard);
    },
  );

  it("runs the CLI launch guard from the CLI entry", () => {
    expect(
      readFileSync(join(repoRoot, "apps/cli/src/index.ts"), "utf8"),
    ).toContain("guardCliLaunch()");
  });
});
