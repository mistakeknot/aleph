import { describe, expect, it } from "vitest";
import {
  MINIMUM_FENCE_AWARE_ALEPH_VERSION,
  defaultWriterCandidates,
  detectExternalWriters,
  isFenceAwareVersion,
} from "../src/external-writers.js";

describe("isFenceAwareVersion", () => {
  it("accepts Aleph versions at or above the first fence release", () => {
    expect(
      isFenceAwareVersion(`0.44.0+aleph.${MINIMUM_FENCE_AWARE_ALEPH_VERSION}`),
    ).toBe(true);
    expect(isFenceAwareVersion("0.44.0+aleph.0.5.1")).toBe(true);
    expect(isFenceAwareVersion("0.44.0+aleph.1.0.0")).toBe(true);
  });

  it("rejects older Aleph builds, stock bb and garbage", () => {
    expect(isFenceAwareVersion("0.44.0+aleph.0.4.9")).toBe(false);
    expect(isFenceAwareVersion("0.44.0")).toBe(false);
    expect(isFenceAwareVersion("")).toBe(false);
    expect(isFenceAwareVersion("not a version")).toBe(false);
  });
});

describe("detectExternalWriters", () => {
  const aware = "0.44.0+aleph.0.5.0";

  it("allows auto-update when every external writer is fence-aware", async () => {
    const result = await detectExternalWriters({
      candidates: ["/opt/a/bb"],
      bundlePath: "/Applications/Aleph.app",
      probeVersion: async () => aware,
    });
    expect(result).toEqual({ autoUpdateAllowed: true, writers: [] });
  });

  it("flags a pre-fence Aleph writer and disables auto-update", async () => {
    const result = await detectExternalWriters({
      candidates: ["/opt/old/bb"],
      bundlePath: "/Applications/Aleph.app",
      probeVersion: async () => "0.44.0+aleph.0.4.0",
    });
    expect(result.autoUpdateAllowed).toBe(false);
    expect(result.writers).toEqual([
      {
        path: "/opt/old/bb",
        version: "0.44.0+aleph.0.4.0",
        reason: "predates_fence",
      },
    ]);
  });

  it("fails closed when a candidate cannot be probed", async () => {
    const result = await detectExternalWriters({
      candidates: ["/opt/odd/bb", "/opt/throws/bb"],
      bundlePath: "/Applications/Aleph.app",
      probeVersion: async (path) => {
        if (path.includes("throws")) throw new Error("spawn failed");
        return null;
      },
    });
    expect(result.autoUpdateAllowed).toBe(false);
    expect(result.writers.map((writer) => writer.reason)).toEqual([
      "unprobeable",
      "unprobeable",
    ]);
  });

  it("ignores candidates inside the running bundle and duplicates", async () => {
    const probed: string[] = [];
    const result = await detectExternalWriters({
      candidates: [
        "/Applications/Aleph.app/Contents/Resources/bb",
        "/opt/a/bb",
        "/opt/a/bb",
      ],
      bundlePath: "/Applications/Aleph.app",
      probeVersion: async (path) => {
        probed.push(path);
        return aware;
      },
    });
    expect(probed).toEqual(["/opt/a/bb"]);
    expect(result.autoUpdateAllowed).toBe(true);
  });

  it("does not treat stock bb as an Aleph writer", async () => {
    const result = await detectExternalWriters({
      candidates: ["/usr/local/bin/bb"],
      bundlePath: "/Applications/Aleph.app",
      probeVersion: async () => "0.44.0",
      isStockBb: (version) => !version.includes("+aleph."),
    });
    expect(result).toEqual({ autoUpdateAllowed: true, writers: [] });
  });
});

describe("defaultWriterCandidates", () => {
  it("lists PATH bb binaries and the standard user install locations once", () => {
    const candidates = defaultWriterCandidates({
      homeDir: "/home/u",
      pathEnv: "/usr/local/bin:/home/u/.local/bin",
    });
    expect(candidates).toContain("/usr/local/bin/bb");
    expect(candidates).toContain("/home/u/.local/bin/bb");
    expect(candidates).toContain("/home/u/.aleph/npm/bin/bb-app");
    expect(new Set(candidates).size).toBe(candidates.length);
  });
});
