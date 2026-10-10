import { describe, expect, it } from "vitest";
import {
  AlephManifestEntryError,
  compareAlephRelease,
  parseAlephRelease,
  selectAlephUpdate,
  type AlephManifestEntry,
} from "../src/aleph-update-select.js";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);
const ARTIFACT_KEY = "linux-x64-closure";

function entry(
  aleph: string,
  overrides: Partial<AlephManifestEntry> = {},
): AlephManifestEntry {
  return {
    aleph,
    version: `0.44.0+aleph.${aleph}`,
    upstreamBase: "0.44.0",
    migrations: [
      { tag: "0001_init", when: 1000, sha256: SHA_A },
      { tag: "0002_more", when: 2000, sha256: SHA_B },
    ],
    artifactKeys: [ARTIFACT_KEY],
    ...overrides,
  };
}

describe("parseAlephRelease and compareAlephRelease", () => {
  it("parses normalized x.y.z releases", () => {
    expect(parseAlephRelease("0.5.3")).toEqual([0, 5, 3]);
    expect(parseAlephRelease("10.0.9999")).toEqual([10, 0, 9999]);
  });

  it.each([
    "",
    "1.2",
    "1.2.3.4",
    "01.2.3",
    "1.02.3",
    "1.2.03",
    "1.2.10000",
    "a.b.c",
    "1.2.3-rc",
    " 1.2.3",
  ])("rejects %j", (value) => {
    expect(parseAlephRelease(value)).toBeNull();
  });

  it("orders numerically, not lexically", () => {
    expect(compareAlephRelease("0.5.10", "0.5.9")).toBeGreaterThan(0);
    expect(compareAlephRelease("0.5.3", "0.5.3")).toBe(0);
    expect(compareAlephRelease("0.4.9", "0.5.0")).toBeLessThan(0);
    expect(compareAlephRelease("1.0.0", "0.99.99")).toBeGreaterThan(0);
  });

  it("throws on a value that is not a normalized release", () => {
    expect(() => compareAlephRelease("0.5", "0.5.3")).toThrow();
  });
});

describe("selectAlephUpdate", () => {
  const installed = "0.44.0+aleph.0.5.3";

  it("selects the highest newer release", () => {
    const result = selectAlephUpdate({
      installedVersion: installed,
      entries: [entry("0.5.3"), entry("0.5.5"), entry("0.5.4")],
      revocations: [],
      artifactKey: ARTIFACT_KEY,
    });
    expect(result).toMatchObject({ selection: "available", target: "0.5.5" });
  });

  it("reports up-to-date when nothing is newer", () => {
    const result = selectAlephUpdate({
      installedVersion: installed,
      entries: [entry("0.5.2"), entry("0.5.3")],
      revocations: [],
      artifactKey: ARTIFACT_KEY,
    });
    expect(result).toMatchObject({ selection: "up-to-date", target: null });
  });

  it("never selects an upstream build and is not-comparable from one", () => {
    expect(
      selectAlephUpdate({
        installedVersion: "0.45.0",
        entries: [entry("0.5.4")],
        revocations: [],
        artifactKey: ARTIFACT_KEY,
      }),
    ).toMatchObject({ selection: "not-comparable", target: null });
    expect(
      selectAlephUpdate({
        installedVersion: installed,
        entries: [entry("0.5.3"), entry("0.5.4", { version: "9.9.9" })],
        revocations: [],
        artifactKey: ARTIFACT_KEY,
      }),
    ).toMatchObject({ selection: "up-to-date", target: null });
  });

  it("skips revoked entries", () => {
    const result = selectAlephUpdate({
      installedVersion: installed,
      entries: [entry("0.5.3"), entry("0.5.4"), entry("0.5.5")],
      revocations: [{ aleph: "0.5.5", reason: "synthetic", sequence: 7 }],
      artifactKey: ARTIFACT_KEY,
    });
    expect(result).toMatchObject({ selection: "available", target: "0.5.4" });
  });

  it("flags a revoked installed release and still offers a newer target", () => {
    const result = selectAlephUpdate({
      installedVersion: installed,
      entries: [entry("0.5.3"), entry("0.5.4")],
      revocations: [{ aleph: "0.5.3", reason: "synthetic", sequence: 7 }],
      artifactKey: ARTIFACT_KEY,
    });
    expect(result).toMatchObject({
      selection: "installed-revoked",
      target: "0.5.4",
    });
  });

  it("reports installed-revoked with no target when nothing newer exists", () => {
    const result = selectAlephUpdate({
      installedVersion: installed,
      entries: [entry("0.5.3")],
      revocations: [{ aleph: "0.5.3", reason: "synthetic", sequence: 7 }],
      artifactKey: ARTIFACT_KEY,
    });
    expect(result).toMatchObject({
      selection: "installed-revoked",
      target: null,
    });
  });

  it("orders by the Aleph release only, across upstream base syncs", () => {
    const result = selectAlephUpdate({
      installedVersion: installed,
      entries: [
        entry("0.5.3"),
        entry("0.5.4", {
          version: "0.45.1+aleph.0.5.4",
          upstreamBase: "0.45.1",
        }),
      ],
      revocations: [],
      artifactKey: ARTIFACT_KEY,
    });
    expect(result).toMatchObject({ selection: "available", target: "0.5.4" });
  });

  it("prefers the highest Aleph release over a higher upstream base", () => {
    const result = selectAlephUpdate({
      installedVersion: installed,
      entries: [
        entry("0.5.3"),
        entry("0.5.4", {
          version: "0.45.0+aleph.0.5.4",
          upstreamBase: "0.45.0",
        }),
        entry("0.5.5"),
      ],
      revocations: [],
      artifactKey: ARTIFACT_KEY,
    });
    expect(result).toEqual({ selection: "available", target: "0.5.5" });
  });

  it("ignores entries whose version disagrees with their Aleph release or base", () => {
    const result = selectAlephUpdate({
      installedVersion: installed,
      entries: [
        entry("0.5.3"),
        entry("0.5.4", { version: "0.44.0+aleph.0.5.9" }),
        entry("0.5.6", { upstreamBase: "0.99.0" }),
      ],
      revocations: [],
      artifactKey: ARTIFACT_KEY,
    });
    expect(result).toMatchObject({ selection: "up-to-date", target: null });
  });

  it("ignores entries without the consumer's artifact key", () => {
    const result = selectAlephUpdate({
      installedVersion: installed,
      entries: [
        entry("0.5.3"),
        entry("0.5.4", { artifactKeys: ["darwin-arm64"] }),
      ],
      revocations: [],
      artifactKey: ARTIFACT_KEY,
    });
    expect(result).toMatchObject({ selection: "up-to-date", target: null });
  });

  it("requires migration review when the migration lists differ", () => {
    const added = entry("0.5.4", {
      migrations: [
        ...entry("0.5.4").migrations,
        { tag: "0003_new", when: 3000, sha256: SHA_C },
      ],
    });
    expect(
      selectAlephUpdate({
        installedVersion: installed,
        entries: [entry("0.5.3"), added],
        revocations: [],
        artifactKey: ARTIFACT_KEY,
      }),
    ).toMatchObject({ selection: "migration-required", target: "0.5.4" });
  });

  it.each([
    [
      "a changed hash",
      [
        { tag: "0001_init", when: 1000, sha256: SHA_A },
        { tag: "0002_more", when: 2000, sha256: SHA_C },
      ],
    ],
    [
      "a changed when",
      [
        { tag: "0001_init", when: 1000, sha256: SHA_A },
        { tag: "0002_more", when: 2001, sha256: SHA_B },
      ],
    ],
    [
      "a changed tag",
      [
        { tag: "0001_init", when: 1000, sha256: SHA_A },
        { tag: "0002_renamed", when: 2000, sha256: SHA_B },
      ],
    ],
    ["a removed migration", [{ tag: "0001_init", when: 1000, sha256: SHA_A }]],
    [
      "a reordered list",
      [
        { tag: "0002_more", when: 2000, sha256: SHA_B },
        { tag: "0001_init", when: 1000, sha256: SHA_A },
      ],
    ],
  ])("requires migration review for %s", (_name, migrations) => {
    expect(
      selectAlephUpdate({
        installedVersion: installed,
        entries: [entry("0.5.3"), entry("0.5.4", { migrations })],
        revocations: [],
        artifactKey: ARTIFACT_KEY,
      }),
    ).toMatchObject({ selection: "migration-required", target: "0.5.4" });
  });

  it("is not-comparable when the installed release has no signed entry", () => {
    expect(
      selectAlephUpdate({
        installedVersion: installed,
        entries: [entry("0.5.4")],
        revocations: [],
        artifactKey: ARTIFACT_KEY,
      }),
    ).toMatchObject({ selection: "not-comparable", target: null });
  });

  it("refuses a migration without a numeric when", () => {
    const broken = entry("0.5.4", {
      migrations: [{ tag: "0001_init", sha256: SHA_A } as never],
    });
    expect(() =>
      selectAlephUpdate({
        installedVersion: installed,
        entries: [entry("0.5.3"), broken],
        revocations: [],
        artifactKey: ARTIFACT_KEY,
      }),
    ).toThrow(AlephManifestEntryError);
  });

  it("refuses a malformed migration sha256 or duplicate release", () => {
    expect(() =>
      selectAlephUpdate({
        installedVersion: installed,
        entries: [
          entry("0.5.3"),
          entry("0.5.4", {
            migrations: [{ tag: "0001_init", when: 1, sha256: "xyz" }],
          }),
        ],
        revocations: [],
        artifactKey: ARTIFACT_KEY,
      }),
    ).toThrow(AlephManifestEntryError);
    expect(() =>
      selectAlephUpdate({
        installedVersion: installed,
        entries: [entry("0.5.3"), entry("0.5.3")],
        revocations: [],
        artifactKey: ARTIFACT_KEY,
      }),
    ).toThrow(AlephManifestEntryError);
  });
});
