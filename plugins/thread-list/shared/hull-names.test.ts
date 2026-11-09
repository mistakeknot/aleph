import { describe, expect, it } from "vitest";
import {
  hullTitlePrefix,
  normalizeHullName,
  resolveHullDesignation,
} from "./hull-names.js";

describe("normalizeHullName", () => {
  it("lowercases and keeps only letters and digits", () => {
    expect(normalizeHullName("Mind State")).toBe("mindstate");
    expect(normalizeHullName("Mind-State")).toBe("mindstate");
    expect(normalizeHullName("mindstate")).toBe("mindstate");
    expect(normalizeHullName("Fashion Something")).toBe("fashionsomething");
    expect(normalizeHullName("  Ünï_cödé 9! ")).toBe("ünïcödé9");
    expect(normalizeHullName("--- ···")).toBe("");
  });

  it("treats composed and decomposed accents as equal", () => {
    expect(normalizeHullName("éclair")).toBe(normalizeHullName("éclair"));
  });
});

describe("hullTitlePrefix", () => {
  it("takes the trimmed text before the first pipe separator", () => {
    expect(hullTitlePrefix("Mind State | worker | extra")).toBe("Mind State");
    expect(hullTitlePrefix("  Aleph  | exec")).toBe("Aleph");
  });

  it("has no prefix without a spaced pipe or with an empty name", () => {
    expect(hullTitlePrefix("Plain title")).toBeNull();
    expect(hullTitlePrefix("a|b")).toBeNull();
    expect(hullTitlePrefix("Trailing |")).toBeNull();
    expect(hullTitlePrefix(" | nameless")).toBeNull();
  });
});

describe("resolveHullDesignation", () => {
  const base = {
    designations: {
      thr_a1: "THREAD",
      proj_a1: "PROJECT",
      proj_b1: "OTHERPROJECT",
    },
    names: { mindstate: "BYNAME" },
  };

  it("resolves thread, then title prefix, then project", () => {
    const args = { ...base, threadId: "thr_a1", projectId: "proj_a1" };
    expect(resolveHullDesignation({ ...args, title: "Mind State | x" })).toBe(
      "THREAD",
    );
    expect(
      resolveHullDesignation({
        ...args,
        threadId: "thr_z9",
        title: "Mind-State | x",
      }),
    ).toBe("BYNAME");
    expect(
      resolveHullDesignation({
        ...args,
        threadId: "thr_z9",
        title: "No prefix",
      }),
    ).toBe("PROJECT");
    expect(
      resolveHullDesignation({
        ...args,
        threadId: "thr_z9",
        title: "Unknown | x",
      }),
    ).toBe("PROJECT");
    expect(
      resolveHullDesignation({
        ...args,
        threadId: "thr_z9",
        projectId: "proj_none",
        title: "Unknown | x",
      }),
    ).toBeUndefined();
  });

  it("ignores inherited object keys", () => {
    expect(
      resolveHullDesignation({
        ...base,
        names: {},
        threadId: "thr_z9",
        projectId: "proj_none",
        title: "Constructor | x",
      }),
    ).toBeUndefined();
    expect(
      resolveHullDesignation({
        ...base,
        threadId: "constructor",
        projectId: "toString",
        title: "plain",
      }),
    ).toBeUndefined();
  });
});
