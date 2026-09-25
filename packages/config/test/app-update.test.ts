import { describe, expect, it } from "vitest";
import { isAlephAppVersion } from "../src/app-update.js";

describe("isAlephAppVersion", () => {
  it("recognizes Aleph build metadata", () => {
    expect(isAlephAppVersion("0.43.4+aleph.1")).toBe(true);
    expect(isAlephAppVersion("0.43.4+aleph.12")).toBe(true);
    expect(isAlephAppVersion("0.44.0-nightly.20260924.1+aleph.3")).toBe(true);
  });

  it("fails closed on malformed Aleph build metadata", () => {
    expect(isAlephAppVersion("0.43.4+aleph")).toBe(true);
    expect(isAlephAppVersion("0.43.4+aleph.3.hotfix")).toBe(true);
    expect(isAlephAppVersion("0.43.4+aleph.3-rc")).toBe(true);
    expect(isAlephAppVersion("0.43.4+build.1.aleph")).toBe(true);
    expect(isAlephAppVersion("0.43.4+aleph-rc.3")).toBe(true);
  });

  it("rejects upstream and other build-metadata versions", () => {
    expect(isAlephAppVersion("0.43.4")).toBe(false);
    expect(isAlephAppVersion("0.44.0-nightly.20260924.1")).toBe(false);
    expect(isAlephAppVersion("0.43.4+build.1")).toBe(false);
    expect(isAlephAppVersion("0.43.4+alephant.1")).toBe(false);
    expect(isAlephAppVersion("0.43.4-aleph.1")).toBe(false);
  });
});
