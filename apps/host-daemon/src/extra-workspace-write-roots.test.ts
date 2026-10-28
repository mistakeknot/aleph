import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EXTRA_WORKSPACE_WRITE_ROOTS_ENV,
  resolveExtraWorkspaceWriteRoots,
} from "./extra-workspace-write-roots.js";

describe("resolveExtraWorkspaceWriteRoots", () => {
  let scratch: string;
  let homeDir: string;
  let dataDir: string;
  let outside: string;
  const logger = { info: vi.fn(), warn: vi.fn() };

  beforeEach(() => {
    scratch = realpathSync(mkdtempSync(path.join(tmpdir(), "bb-extra-roots-")));
    homeDir = path.join(scratch, "home", "mk");
    dataDir = path.join(homeDir, ".bb-machines", "host");
    outside = path.join(scratch, "srv");
    mkdirSync(path.join(dataDir, "plugin-host-artifacts"), { recursive: true });
    mkdirSync(path.join(homeDir, ".codex"), { recursive: true });
    mkdirSync(path.join(homeDir, "build-cache"), { recursive: true });
    mkdirSync(path.join(outside, "build-a"), { recursive: true });
    mkdirSync(path.join(outside, "build-b"), { recursive: true });
    mkdirSync(path.join(scratch, "home", "mk2"), { recursive: true });
    logger.info.mockReset();
    logger.warn.mockReset();
  });

  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  function resolve(value: string | undefined): string[] {
    return resolveExtraWorkspaceWriteRoots({
      env:
        value === undefined ? {} : { [EXTRA_WORKSPACE_WRITE_ROOTS_ENV]: value },
      dataDir,
      homeDir,
      logger,
    });
  }

  function warnedReasons(): string[] {
    return logger.warn.mock.calls.map(
      ([fields]) => (fields as { reason: string }).reason,
    );
  }

  it("returns no roots and logs nothing when unset or blank", () => {
    expect(resolve(undefined)).toEqual([]);
    expect(resolve("")).toEqual([]);
    expect(resolve(` ${path.delimiter} `)).toEqual([]);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
  });

  it("accepts existing absolute directories in order, trimmed and de-duplicated", () => {
    const a = path.join(outside, "build-a");
    const b = path.join(outside, "build-b");
    expect(resolve([` ${a} `, "", b, a].join(path.delimiter))).toEqual([a, b]);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledTimes(1);
  });

  it("resolves symlinks to the real directory and de-duplicates alias and target", () => {
    const target = path.join(outside, "build-a");
    const alias = path.join(scratch, "alias");
    symlinkSync(target, alias, "dir");
    expect(resolve([alias, target].join(path.delimiter))).toEqual([target]);
  });

  it("drops relative, missing and non-directory entries with a warning each", () => {
    const file = path.join(outside, "file.txt");
    writeFileSync(file, "x");
    const kept = path.join(outside, "build-a");
    expect(
      resolve(
        ["relative/dir", path.join(outside, "missing"), file, kept].join(
          path.delimiter,
        ),
      ),
    ).toEqual([kept]);
    expect(warnedReasons()).toEqual([
      "not an absolute path",
      "does not exist",
      "not a directory",
    ]);
  });

  it("refuses the filesystem root", () => {
    expect(resolve(path.parse(scratch).root)).toEqual([]);
    expect(warnedReasons()).toEqual(["is a filesystem root"]);
  });

  it("refuses the home directory and its ancestors", () => {
    expect(
      resolve([homeDir, path.dirname(homeDir)].join(path.delimiter)),
    ).toEqual([]);
    expect(warnedReasons()).toEqual([
      "is the home directory or contains it",
      "is the home directory or contains it",
    ]);
  });

  it("refuses the data directory, its ancestors and anything inside it", () => {
    const outsideHomeData = path.join(outside, "data");
    mkdirSync(path.join(outsideHomeData, "inner"), { recursive: true });
    const result = resolveExtraWorkspaceWriteRoots({
      env: {
        [EXTRA_WORKSPACE_WRITE_ROOTS_ENV]: [
          outsideHomeData,
          outside,
          path.join(outsideHomeData, "inner"),
        ].join(path.delimiter),
      },
      dataDir: outsideHomeData,
      homeDir,
      logger,
    });
    expect(result).toEqual([]);
    expect(warnedReasons()).toEqual([
      "overlaps the bb data directory",
      "overlaps the bb data directory",
      "overlaps the bb data directory",
    ]);
  });

  it("refuses entries inside the data dir and home dot-directories", () => {
    expect(
      resolve(
        [
          path.join(dataDir, "plugin-host-artifacts"),
          path.join(homeDir, ".codex"),
        ].join(path.delimiter),
      ),
    ).toEqual([]);
    expect(warnedReasons()).toEqual([
      "overlaps the bb data directory",
      "is inside a dot-directory of the home directory",
    ]);
  });

  it("accepts a plain directory under home and a sibling whose name shares the home prefix", () => {
    const buildCache = path.join(homeDir, "build-cache");
    const sibling = path.join(scratch, "home", "mk2");
    expect(resolve([buildCache, sibling].join(path.delimiter))).toEqual([
      buildCache,
      sibling,
    ]);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
