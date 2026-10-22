import {
  chmodSync,
  cpSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { materializeLegacyCompatibleFolder } from "../src/legacy-compat-folder.js";
import { sourceFolders } from "./helpers/plan-apply.js";

const hooks = vi.hoisted(() => ({
  beforeRename: undefined as ((from: string, to: string) => void) | undefined,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    renameSync: (from: string, to: string) => {
      const hook = hooks.beforeRename;
      if (hook === undefined) return actual.renameSync(from, to);
      hook(from, to);
      throw Object.assign(new Error("ENOTEMPTY"), { code: "ENOTEMPTY" });
    },
  };
});

let cacheRoot = "";
let outside = "";

beforeEach(() => {
  cacheRoot = mkdtempSync(join(tmpdir(), "bb-compat-test-"));
  outside = mkdtempSync(join(tmpdir(), "bb-compat-outside-"));
});

afterEach(() => {
  hooks.beforeRename = undefined;
  vi.restoreAllMocks();
  for (const dir of [cacheRoot, outside]) {
    rmSync(dir, { force: true, recursive: true });
  }
});

function sqlFiles(folder: string): string[] {
  return readdirSync(folder)
    .filter((name) => name.endsWith(".sql"))
    .sort();
}

function expectEquivalent(folder: string, reference: string): void {
  expect(sqlFiles(folder)).toEqual(sqlFiles(reference));
  expect(readFileSync(join(folder, "meta", "_journal.json"))).toEqual(
    readFileSync(join(reference, "meta", "_journal.json")),
  );
  for (const name of sqlFiles(reference)) {
    expect(readFileSync(join(folder, name))).toEqual(
      readFileSync(join(reference, name)),
    );
  }
}

function cachedFolder(): { folder: string; reference: string } {
  const folder = materializeLegacyCompatibleFolder(sourceFolders, cacheRoot);
  const reference = join(outside, "reference");
  cpSync(folder, reference, { recursive: true });
  return { folder, reference };
}

function firstSql(folder: string): string {
  const name = sqlFiles(folder)[0];
  if (name === undefined) throw new Error("the compat folder has no SQL");
  return join(folder, name);
}

describe("the legacy compat folder cache", () => {
  it("reuses a cached folder it can trust", () => {
    const { folder } = cachedFolder();
    expect(materializeLegacyCompatibleFolder(sourceFolders, cacheRoot)).toBe(
      folder,
    );
    expect(readdirSync(cacheRoot)).toEqual([
      expect.stringMatching(/^bb-migrations-/),
    ]);
  });

  it("writes folders and files only its owner can change", () => {
    const { folder } = cachedFolder();
    for (const path of [
      folder,
      join(folder, "meta"),
      join(folder, "meta", "_journal.json"),
      firstSql(folder),
    ]) {
      expect(statSync(path).mode & 0o022).toBe(0);
    }
  });

  it.each([
    ["the folder", (folder: string) => folder, 0o777],
    ["the folder being group writable", (folder: string) => folder, 0o770],
    ["meta", (folder: string) => join(folder, "meta"), 0o777],
    [
      "the journal",
      (folder: string) => join(folder, "meta", "_journal.json"),
      0o666,
    ],
    ["a SQL file", firstSql, 0o666],
    ["a SQL file being group writable", firstSql, 0o660],
  ])("distrusts %s being writable by others", (_name, pick, mode) => {
    const { folder, reference } = cachedFolder();
    chmodSync(pick(folder), mode);
    const result = materializeLegacyCompatibleFolder(sourceFolders, cacheRoot);
    expect(result).not.toBe(folder);
    expectEquivalent(result, reference);
  });

  it("distrusts a folder owned by another user", () => {
    const { folder, reference } = cachedFolder();
    const uid = process.getuid?.() ?? 0;
    vi.spyOn(process, "getuid").mockReturnValue(uid + 1);
    const result = materializeLegacyCompatibleFolder(sourceFolders, cacheRoot);
    expect(result).not.toBe(folder);
    expectEquivalent(result, reference);
  });

  it("distrusts a symlinked SQL file whose bytes match", () => {
    const { folder, reference } = cachedFolder();
    const sql = firstSql(folder);
    const external = join(outside, "external.sql");
    writeFileSync(external, readFileSync(sql));
    unlinkSync(sql);
    symlinkSync(external, sql);
    const result = materializeLegacyCompatibleFolder(sourceFolders, cacheRoot);
    expect(result).not.toBe(folder);
    expectEquivalent(result, reference);
  });

  it("distrusts a symlinked journal whose bytes match", () => {
    const { folder, reference } = cachedFolder();
    const journal = join(folder, "meta", "_journal.json");
    const external = join(outside, "journal.json");
    writeFileSync(external, readFileSync(journal));
    unlinkSync(journal);
    symlinkSync(external, journal);
    const result = materializeLegacyCompatibleFolder(sourceFolders, cacheRoot);
    expect(result).not.toBe(folder);
    expectEquivalent(result, reference);
  });

  it("distrusts a symlinked meta directory", () => {
    const { folder, reference } = cachedFolder();
    const meta = join(folder, "meta");
    const external = join(outside, "meta");
    cpSync(meta, external, { recursive: true });
    rmSync(meta, { recursive: true });
    symlinkSync(external, meta);
    const result = materializeLegacyCompatibleFolder(sourceFolders, cacheRoot);
    expect(result).not.toBe(folder);
    expectEquivalent(result, reference);
  });

  it("distrusts a symlinked folder", () => {
    const { folder, reference } = cachedFolder();
    const moved = join(outside, "moved");
    cpSync(folder, moved, { recursive: true });
    rmSync(folder, { recursive: true });
    symlinkSync(moved, folder);
    const result = materializeLegacyCompatibleFolder(sourceFolders, cacheRoot);
    expect(result).not.toBe(folder);
    expectEquivalent(result, reference);
  });

  it.each([
    ["a SQL file", firstSql],
    ["the journal", (folder: string) => join(folder, "meta", "_journal.json")],
  ])("distrusts a tampered %s", (_name, pick) => {
    const { folder, reference } = cachedFolder();
    const path = pick(folder);
    writeFileSync(path, `${readFileSync(path, "utf8")} `);
    const result = materializeLegacyCompatibleFolder(sourceFolders, cacheRoot);
    expect(result).not.toBe(folder);
    expectEquivalent(result, reference);
  });

  it("distrusts a cached folder that lost a file", () => {
    const { folder, reference } = cachedFolder();
    unlinkSync(firstSql(folder));
    const result = materializeLegacyCompatibleFolder(sourceFolders, cacheRoot);
    expect(result).not.toBe(folder);
    expectEquivalent(result, reference);
  });

  describe("when another process wins the rename", () => {
    it("uses the winner's folder when it is trustworthy", () => {
      hooks.beforeRename = (from, to) => {
        cpSync(from, to, { recursive: true });
        chmodSync(to, 0o700);
        chmodSync(join(to, "meta"), 0o700);
      };
      const result = materializeLegacyCompatibleFolder(
        sourceFolders,
        cacheRoot,
      );
      expect(result).toMatch(/bb-migrations-(?!staging)/);
      expect(result.startsWith(cacheRoot)).toBe(true);
    });

    it("falls back to its own staging folder when the winner is tampered", () => {
      const reference = join(outside, "reference");
      hooks.beforeRename = (from, to) => {
        cpSync(from, reference, { recursive: true });
        cpSync(from, to, { recursive: true });
        const sql = join(to, sqlFiles(to)[0] ?? "");
        writeFileSync(sql, `${readFileSync(sql, "utf8")} `);
      };
      const result = materializeLegacyCompatibleFolder(
        sourceFolders,
        cacheRoot,
      );
      expect(result).toMatch(/bb-migrations-staging-/);
      expectEquivalent(result, reference);
    });

    it("falls back to its own staging folder when the winner is writable by others", () => {
      const reference = join(outside, "reference");
      hooks.beforeRename = (from, to) => {
        cpSync(from, reference, { recursive: true });
        cpSync(from, to, { recursive: true });
        chmodSync(join(to, "meta"), 0o777);
      };
      const result = materializeLegacyCompatibleFolder(
        sourceFolders,
        cacheRoot,
      );
      expect(result).toMatch(/bb-migrations-staging-/);
      expectEquivalent(result, reference);
    });
  });
});
