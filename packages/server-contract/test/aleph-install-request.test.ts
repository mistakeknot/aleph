import { describe, expect, it } from "vitest";
import { systemAlephInstallRequestSchema } from "../src/index.js";

const base = { manifestDigest: "f".repeat(64), nonce: "a".repeat(32) };

describe("systemAlephInstallRequestSchema", () => {
  it("accepts a manifest-length version", () => {
    const target = "9999.9999.9999+aleph.9999.9999.9999";
    expect(
      systemAlephInstallRequestSchema.safeParse({ ...base, target }).success,
    ).toBe(true);
  });

  it("rejects an empty or oversized version", () => {
    for (const target of ["", "1".repeat(101)]) {
      expect(
        systemAlephInstallRequestSchema.safeParse({ ...base, target }).success,
      ).toBe(false);
    }
  });
});
