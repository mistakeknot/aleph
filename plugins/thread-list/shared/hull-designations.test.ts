import { mkdtempSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createHullDesignationsReader,
  parseHullDesignations,
  resolveHullDesignationsPath,
} from "./hull-designations.js";

const dirs: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "hull-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("parseHullDesignations", () => {
  it("keeps only approved rows with a designation and ignores extra fields", () => {
    expect(
      parseHullDesignations([
        { projectId: "proj_test1", designation: "GSV-T1·◐", approved: true, note: "x" },
        { projectId: "proj_test2", designation: "GSV-T2·◐", approved: false },
        { projectId: "proj_test3", designation: "  ", approved: true },
        { projectId: "proj_test4", approved: true },
        { projectId: "proj_test5", designation: "GSV-T5·⬡", approved: "true" },
        { designation: "GSV-T6·◐", approved: true },
        null,
        "junk",
      ]),
    ).toEqual({ proj_test1: "GSV-T1·◐" });
  });

  it("returns empty for a non-array", () => {
    expect(parseHullDesignations({ projectId: "a" })).toEqual({});
  });
});

describe("resolveHullDesignationsPath", () => {
  it("defaults to the data dir and honours the env override", () => {
    expect(resolveHullDesignationsPath("/d", {})).toBe("/d/hull-designations.json");
    expect(
      resolveHullDesignationsPath("/d", { BB_HULL_DESIGNATIONS_FILE: "/x/y.json" }),
    ).toBe("/x/y.json");
  });
});

describe("createHullDesignationsReader", () => {
  const row = (d: string) =>
    JSON.stringify([{ projectId: "proj_test1", designation: d, approved: true }]);

  it("returns empty for a missing file", () => {
    const read = createHullDesignationsReader(() => join(tmp(), "none.json"));
    expect(read()).toEqual({});
  });

  it("returns empty for a malformed file", () => {
    const path = join(tmp(), "h.json");
    writeFileSync(path, "{not json");
    expect(createHullDesignationsReader(() => path)()).toEqual({});
  });

  it("caches by mtime and reloads when the file changes", () => {
    const path = join(tmp(), "h.json");
    writeFileSync(path, row("GSV-T1·◐"));
    utimesSync(path, 1000, 1000);
    const read = createHullDesignationsReader(() => path);
    const first = read();
    expect(first).toEqual({ proj_test1: "GSV-T1·◐" });
    expect(read()).toBe(first);
    writeFileSync(path, row("GSV-T9·◐"));
    utimesSync(path, 2000, 2000);
    expect(read()).toEqual({ proj_test1: "GSV-T9·◐" });
  });

  it("serves the cached value even if same-mtime content differs", () => {
    const path = join(tmp(), "h.json");
    writeFileSync(path, row("GSV-T1·◐"));
    utimesSync(path, 1000, 1000);
    const read = createHullDesignationsReader(() => path);
    read();
    writeFileSync(path, row("GSV-T2·◐"));
    utimesSync(path, 1000, 1000);
    expect(read()).toEqual({ proj_test1: "GSV-T1·◐" });
  });
});
