import { describe, expect, it } from "vitest";
import {
  classifyCoordinator,
  type CoordinatorInput,
  type CoordinatorVerdict,
} from "./coordinator";

function classify(
  title: string | null,
  over: Partial<CoordinatorInput> = {},
): CoordinatorVerdict {
  return classifyCoordinator({
    title,
    parentThreadId: null,
    archivedAt: null,
    deletedAt: null,
    ...over,
  });
}

describe("classifyCoordinator", () => {
  it("accepts a piped coordinator title", () => {
    expect(classify("Paperkite | coordinator")).toEqual({
      kind: "coordinator",
      prefix: "Paperkite",
    });
  });

  it("ignores role case and surrounding whitespace", () => {
    expect(classify("Paperkite | Coordinator ")).toEqual({
      kind: "coordinator",
      prefix: "Paperkite",
    });
  });

  it("splits at the last pipe", () => {
    expect(classify("A | B | coordinator")).toEqual({
      kind: "coordinator",
      prefix: "A | B",
    });
  });

  it("rejects the vizier role", () => {
    expect(classify("Masaq' | vizier")).toEqual({
      kind: "not-coordinator",
      reason: "other-role",
    });
  });

  it("rejects a steward role with a bead suffix", () => {
    expect(classify("Masaq' | papercut steward (mk-u0pu)")).toEqual({
      kind: "not-coordinator",
      reason: "other-role",
    });
  });

  it("rejects the publisher role", () => {
    expect(classify("Aleph | publisher")).toEqual({
      kind: "not-coordinator",
      reason: "other-role",
    });
  });

  it("rejects a research role", () => {
    expect(classify("Lumen | lumen-field research")).toEqual({
      kind: "not-coordinator",
      reason: "other-role",
    });
  });

  it("rejects an ordinary title with no role suffix", () => {
    expect(classify("Fix flaky timeline test")).toEqual({
      kind: "not-coordinator",
      reason: "no-role-suffix",
    });
  });

  it("flags an unpiped title ending in the coordinator word", () => {
    expect(classify("Copper Bridge coordinator")).toEqual({
      kind: "no-coordinator-signal",
      reason: "unpiped-coordinator",
    });
  });

  it("does not treat the plural coordinators as the role", () => {
    expect(classify("Organize coordinators/threads")).toEqual({
      kind: "not-coordinator",
      reason: "no-role-suffix",
    });
  });

  it("flags an empty prefix", () => {
    expect(classify(" | coordinator")).toEqual({
      kind: "no-coordinator-signal",
      reason: "empty-prefix",
    });
  });

  it("flags a coordinator role with trailing text", () => {
    expect(classify("Paperkite | coordinator (old)")).toEqual({
      kind: "no-coordinator-signal",
      reason: "unrecognized-suffix",
    });
  });

  it("flags a null title", () => {
    expect(classify(null)).toEqual({
      kind: "no-coordinator-signal",
      reason: "null-title",
    });
  });

  it("flags a blank title", () => {
    expect(classify("   ")).toEqual({
      kind: "no-coordinator-signal",
      reason: "null-title",
    });
  });

  it("rejects a deleted coordinator", () => {
    expect(classify("Paperkite | coordinator", { deletedAt: 1 })).toEqual({
      kind: "not-coordinator",
      reason: "deleted",
    });
  });

  it("rejects an archived coordinator", () => {
    expect(classify("Paperkite | coordinator", { archivedAt: 1 })).toEqual({
      kind: "not-coordinator",
      reason: "archived",
    });
  });

  it("rejects a child thread", () => {
    expect(
      classify("Paperkite | coordinator", { parentThreadId: "thr_x" }),
    ).toEqual({ kind: "not-coordinator", reason: "child" });
  });

  it("is pure: repeated calls agree and the input is untouched", () => {
    const input: CoordinatorInput = {
      title: "A | B | coordinator",
      parentThreadId: null,
      archivedAt: null,
      deletedAt: null,
    };
    const snapshot = structuredClone(input);
    const first = classifyCoordinator(input);
    const second = classifyCoordinator(input);
    expect(second).toEqual(first);
    expect(input).toEqual(snapshot);
  });
});
