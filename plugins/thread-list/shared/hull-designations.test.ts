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
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe("parseHullDesignations", () => {
  it("keeps only approved rows with a designation and ignores extra fields", () => {
    expect(
      parseHullDesignations([
        {
          projectId: "proj_test1",
          designation: "GSV-T1·◐",
          approved: true,
          note: "x",
        },
        { projectId: "proj_test2", designation: "GSV-T2·◐", approved: false },
        { projectId: "proj_test3", designation: "  ", approved: true },
        { projectId: "proj_test4", approved: true },
        { projectId: "proj_test5", designation: "GSV-T5·⬡", approved: "true" },
        { designation: "GSV-T6·◐", approved: true },
        null,
        "junk",
      ]),
    ).toEqual({
      designations: { proj_test1: "GSV-T1·◐" },
      names: {},
    });
  });

  it("keys a threadId row by thread and prefers it over projectId on the same row", () => {
    expect(
      parseHullDesignations([
        { threadId: "thr_test1", designation: "GSV-T1·◐", approved: true },
        {
          threadId: "thr_test2",
          projectId: "proj_x",
          designation: "GSV-T2·◐",
          approved: true,
        },
        { threadId: "thr_test3", designation: "GSV-T3·◐", approved: false },
        { threadId: "", designation: "GSV-T4·◐", approved: true },
      ]),
    ).toEqual({
      designations: { thr_test1: "GSV-T1·◐", thr_test2: "GSV-T2·◐" },
      names: {},
    });
  });

  it("returns empty for a non-array", () => {
    expect(parseHullDesignations({ projectId: "a" })).toEqual({
      designations: {},
      names: {},
    });
  });

  it("normalizes name and aliases into one name map", () => {
    expect(
      parseHullDesignations([
        {
          projectId: "proj_test1",
          name: "Mind State",
          aliases: ["Fashion-Something", "ÉCLAIR 2"],
          designation: "GSV-N1·◐",
          approved: true,
        },
        { name: "Solo", designation: "GSV-N2·◐", approved: true },
      ]),
    ).toEqual({
      designations: { proj_test1: "GSV-N1·◐" },
      names: {
        mindstate: "GSV-N1·◐",
        fashionsomething: "GSV-N1·◐",
        éclair2: "GSV-N1·◐",
        solo: "GSV-N2·◐",
      },
    });
  });

  it("indexes names from threadId rows as well as projectId rows", () => {
    expect(
      parseHullDesignations([
        {
          projectId: "proj_test1",
          name: "Hosts",
          designation: "GSV-P8·◐",
          approved: true,
        },
        {
          threadId: "thr_test1",
          projectId: "proj_test1",
          name: "Rakes of Babel",
          aliases: ["Rakes"],
          designation: "GSV-T4·◐",
          approved: true,
        },
      ]),
    ).toEqual({
      designations: { thr_test1: "GSV-T4·◐", proj_test1: "GSV-P8·◐" },
      names: {
        hosts: "GSV-P8·◐",
        rakesofbabel: "GSV-T4·◐",
        rakes: "GSV-T4·◐",
      },
    });
  });

  it("skips a name that maps to two different designations", () => {
    expect(
      parseHullDesignations([
        {
          projectId: "proj_test1",
          name: "Clavain",
          designation: "GSV-X1·◐",
          approved: true,
        },
        {
          projectId: "proj_test2",
          name: "clavain",
          designation: "GSV-X1·◐",
          approved: true,
        },
        {
          projectId: "proj_test3",
          name: "Shared",
          designation: "GSV-A·◐",
          approved: true,
        },
        {
          projectId: "proj_test4",
          name: "Other",
          aliases: ["shared"],
          designation: "GSV-B·◐",
          approved: true,
        },
        {
          projectId: "proj_test5",
          name: "Third",
          designation: "GSV-C·◐",
          approved: true,
        },
        {
          projectId: "proj_test6",
          name: "Fourth",
          aliases: ["third"],
          designation: "GSV-A·◐",
          approved: true,
        },
      ]).names,
    ).toEqual({
      clavain: "GSV-X1·◐",
      other: "GSV-B·◐",
      fourth: "GSV-A·◐",
    });
  });

  it("ignores names from unapproved rows and does not let them cause conflicts", () => {
    expect(
      parseHullDesignations([
        {
          projectId: "proj_test1",
          name: "Alpha",
          designation: "GSV-A·◐",
          approved: true,
        },
        {
          projectId: "proj_test2",
          name: "Alpha",
          aliases: ["Beta"],
          designation: "GSV-B·◐",
          approved: false,
        },
        {
          projectId: "proj_test3",
          name: "Gamma",
          designation: "GSV-G·◐",
          approved: "true",
        },
        { name: "Delta", designation: "  ", approved: true },
      ]),
    ).toEqual({
      designations: { proj_test1: "GSV-A·◐" },
      names: { alpha: "GSV-A·◐" },
    });
  });

  it("drops malformed alias entries and keeps the valid ones", () => {
    expect(
      parseHullDesignations([
        {
          projectId: "proj_test1",
          name: "Alpha",
          aliases: ["Good Alias", 7, null, {}, "", "  -- ", ["nested"]],
          designation: "GSV-A·◐",
          approved: true,
        },
        {
          projectId: "proj_test2",
          name: "Beta",
          aliases: "not-an-array",
          designation: "GSV-B·◐",
          approved: true,
        },
        {
          projectId: "proj_test3",
          name: 5,
          designation: "GSV-C·◐",
          approved: true,
        },
      ]),
    ).toEqual({
      designations: {
        proj_test1: "GSV-A·◐",
        proj_test2: "GSV-B·◐",
        proj_test3: "GSV-C·◐",
      },
      names: {
        alpha: "GSV-A·◐",
        goodalias: "GSV-A·◐",
        beta: "GSV-B·◐",
      },
    });
  });
});

describe("resolveHullDesignationsPath", () => {
  it("defaults to the data dir and honours the env override", () => {
    expect(resolveHullDesignationsPath("/d", {})).toBe(
      "/d/hull-designations.json",
    );
    expect(
      resolveHullDesignationsPath("/d", {
        BB_HULL_DESIGNATIONS_FILE: "/x/y.json",
      }),
    ).toBe("/x/y.json");
  });
});

describe("createHullDesignationsReader", () => {
  const row = (d: string) =>
    JSON.stringify([
      { projectId: "proj_test1", designation: d, approved: true },
    ]);

  it("returns empty for a missing file", () => {
    const read = createHullDesignationsReader(() => join(tmp(), "none.json"));
    expect(read()).toEqual({ designations: {}, names: {} });
  });

  it("returns empty for a malformed file", () => {
    const path = join(tmp(), "h.json");
    writeFileSync(path, "{not json");
    expect(createHullDesignationsReader(() => path)()).toEqual({
      designations: {},
      names: {},
    });
  });

  it("caches by mtime and reloads when the file changes", () => {
    const path = join(tmp(), "h.json");
    writeFileSync(path, row("GSV-T1·◐"));
    utimesSync(path, 1000, 1000);
    const read = createHullDesignationsReader(() => path);
    const first = read();
    expect(first).toEqual({
      designations: { proj_test1: "GSV-T1·◐" },
      names: {},
    });
    expect(read()).toBe(first);
    writeFileSync(path, row("GSV-T9·◐"));
    utimesSync(path, 2000, 2000);
    expect(read()).toEqual({
      designations: { proj_test1: "GSV-T9·◐" },
      names: {},
    });
  });

  it("reloads when only the size changes", () => {
    const path = join(tmp(), "h.json");
    writeFileSync(path, row("GSV-T1·◐"));
    utimesSync(path, 1000, 1000);
    const read = createHullDesignationsReader(() => path);
    expect(read()).toEqual({
      designations: { proj_test1: "GSV-T1·◐" },
      names: {},
    });
    writeFileSync(path, row("GSV-T1-LONGER·◐"));
    utimesSync(path, 1000, 1000);
    expect(read()).toEqual({
      designations: { proj_test1: "GSV-T1-LONGER·◐" },
      names: {},
    });
  });

  it("drops to empty when a valid file is deleted", () => {
    const path = join(tmp(), "h.json");
    writeFileSync(path, row("GSV-T1·◐"));
    const read = createHullDesignationsReader(() => path);
    expect(read()).toEqual({
      designations: { proj_test1: "GSV-T1·◐" },
      names: {},
    });
    rmSync(path);
    expect(read()).toEqual({ designations: {}, names: {} });
  });

  it("drops to empty when a valid file becomes malformed", () => {
    const path = join(tmp(), "h.json");
    writeFileSync(path, row("GSV-T1·◐"));
    utimesSync(path, 1000, 1000);
    const read = createHullDesignationsReader(() => path);
    expect(read()).toEqual({
      designations: { proj_test1: "GSV-T1·◐" },
      names: {},
    });
    writeFileSync(path, "[{broken");
    utimesSync(path, 2000, 2000);
    expect(read()).toEqual({ designations: {}, names: {} });
  });

  it("serves the cached value even if same-mtime content differs", () => {
    const path = join(tmp(), "h.json");
    writeFileSync(path, row("GSV-T1·◐"));
    utimesSync(path, 1000, 1000);
    const read = createHullDesignationsReader(() => path);
    read();
    writeFileSync(path, row("GSV-T2·◐"));
    utimesSync(path, 1000, 1000);
    expect(read()).toEqual({
      designations: { proj_test1: "GSV-T1·◐" },
      names: {},
    });
  });
});
