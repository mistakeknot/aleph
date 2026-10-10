import { describe, expect, it } from "vitest";
import {
  AlephManifestError,
  canonicalJson,
  checkManifestTransition,
  manifestDigest,
  parseManifestBytes,
  type AlephManifest,
} from "../src/aleph-manifest.js";
import { hex64, makeManifest, makeRelease } from "./aleph-manifest-fixtures.js";

function bytesOf(manifest: unknown): string {
  return canonicalJson(manifest);
}

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof AlephManifestError) return error.code;
    throw error;
  }
  return "no-error";
}

function parsed(manifest: AlephManifest) {
  return parseManifestBytes(bytesOf(manifest));
}

describe("canonicalJson", () => {
  it("sorts keys, drops whitespace and keeps arrays ordered", () => {
    expect(canonicalJson({ b: [2, 1], a: { d: null, c: "x" } })).toBe(
      '{"a":{"c":"x","d":null},"b":[2,1]}',
    );
  });

  it("emits UTF-8 without escaping non-ASCII text", () => {
    expect(Buffer.from(canonicalJson({ a: "é" }), "utf8").length).toBe(
      '{"a":"é"}'.length + 1,
    );
  });

  it("refuses values JSON cannot carry exactly", () => {
    expect(() => canonicalJson({ a: 1.5 })).toThrow();
    expect(() => canonicalJson({ a: Number.NaN })).toThrow();
    expect(() => canonicalJson({ a: undefined })).toThrow();
  });
});

describe("parseManifestBytes", () => {
  it("accepts canonical bytes and reports their digest", () => {
    const manifest = makeManifest();
    const result = parseManifestBytes(bytesOf(manifest));
    expect(result.manifest).toEqual(manifest);
    expect(result.digest).toBe(manifestDigest(bytesOf(manifest)));
    expect(result.digest).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("refuses pretty-printed, reordered, newline-terminated and BOM bytes", () => {
    const manifest = makeManifest();
    const canonical = bytesOf(manifest);
    expect(
      codeOf(() => parseManifestBytes(JSON.stringify(manifest, null, 2))),
    ).toBe("non-canonical");
    expect(codeOf(() => parseManifestBytes(`${canonical}\n`))).toBe(
      "non-canonical",
    );
    expect(codeOf(() => parseManifestBytes(`﻿${canonical}`))).toBe("malformed");
    expect(codeOf(() => parseManifestBytes(JSON.stringify(manifest)))).toBe(
      "non-canonical",
    );
  });

  it("refuses invalid JSON and invalid UTF-8", () => {
    expect(codeOf(() => parseManifestBytes("{"))).toBe("malformed");
    expect(
      codeOf(() => parseManifestBytes(Buffer.from([0x7b, 0xff, 0x7d]))),
    ).toBe("malformed");
  });

  it("refuses extra fields at every level", () => {
    const manifest = makeManifest();
    const release = makeRelease();
    for (const mutated of [
      { ...manifest, extra: 1 },
      { ...manifest, releases: [{ ...release, extra: 1 }] },
      {
        ...manifest,
        releases: [
          { ...release, toolchain: { ...release.toolchain, extra: "x" } },
        ],
      },
      {
        ...manifest,
        releases: [
          {
            ...release,
            artifacts: {
              ...release.artifacts,
              "windows-x64": release.artifacts["linux-x64-closure"],
            },
          },
        ],
      },
      {
        ...manifest,
        revocations: [{ aleph: "0.5.2", reason: "r", sequence: 1, extra: 1 }],
      },
    ]) {
      expect(codeOf(() => parseManifestBytes(bytesOf(mutated)))).toBe("schema");
    }
  });

  it("refuses a wrong schema tag, bad hashes and malformed timestamps", () => {
    const manifest = makeManifest();
    const release = makeRelease();
    for (const mutated of [
      { ...manifest, schema: "aleph-manifest/1" },
      { ...manifest, sequence: 0 },
      { ...manifest, sequence: 1.5 },
      { ...manifest, issued_at: "2026-10-06 12:00:00" },
      { ...manifest, issued_at: "2026-02-30T12:00:00Z" },
      { ...manifest, signer_fingerprint: "SHA256:short" },
      { ...manifest, releases: [] },
      {
        ...manifest,
        releases: [{ ...release, source_sha: "abc" }],
      },
    ]) {
      expect(codeOf(() => parseManifestBytes(JSON.stringify(mutated)))).toBe(
        "schema",
      );
    }
  });

  it("requires previous_digest to be null only for sequence 1", () => {
    expect(
      codeOf(() =>
        parsed(makeManifest({ sequence: 2, previous_digest: null })),
      ),
    ).toBe("schema");
    expect(
      codeOf(() =>
        parsed(makeManifest({ sequence: 1, previous_digest: hex64("x") })),
      ),
    ).toBe("schema");
    expect(
      codeOf(() =>
        parsed(makeManifest({ sequence: 2, previous_digest: hex64("x") })),
      ),
    ).toBe("no-error");
  });

  it("normalizes the aleph version and ties it to the package version", () => {
    for (const aleph of ["0.05.4", "0.5", "00000.5.4", "0.5.4.1", "v0.5.4"]) {
      const release = makeRelease("0.5.4", {
        aleph,
        version: `0.44.0+aleph.${aleph}`,
      });
      expect(codeOf(() => parsed(makeManifest({ releases: [release] })))).toBe(
        "schema",
      );
    }
    const mismatched = makeRelease("0.5.4", { version: "0.44.0+aleph.0.5.5" });
    expect(codeOf(() => parsed(makeManifest({ releases: [mismatched] })))).toBe(
      "schema",
    );
    const wrongBase = makeRelease("0.5.4", { upstream_base: "0.43.9" });
    expect(codeOf(() => parsed(makeManifest({ releases: [wrongBase] })))).toBe(
      "schema",
    );
  });

  it("refuses duplicate releases, duplicate migrations and duplicate revocations", () => {
    const release = makeRelease("0.5.4");
    expect(
      codeOf(() => parsed(makeManifest({ releases: [release, release] }))),
    ).toBe("schema");
    const first = release.db.migrations[0];
    expect(
      codeOf(() =>
        parsed(
          makeManifest({
            releases: [{ ...release, db: { migrations: [first, first] } }],
          }),
        ),
      ),
    ).toBe("schema");
    const revocation = { aleph: "0.5.2", reason: "synthetic", sequence: 1 };
    expect(
      codeOf(() =>
        parsed(makeManifest({ revocations: [revocation, revocation] })),
      ),
    ).toBe("schema");
  });

  it("refuses a migration without a numeric when", () => {
    const release = makeRelease();
    const broken = {
      ...release,
      db: { migrations: [{ tag: "0001_first", sha256: hex64("m1") }] },
    };
    expect(
      codeOf(() =>
        parseManifestBytes(
          bytesOf(makeManifest({ releases: [broken as never] })),
        ),
      ),
    ).toBe("schema");
  });

  it("requires the linux artifact hash to equal the qualified archive hash", () => {
    const release = makeRelease();
    const artifacts = {
      ...release.artifacts,
      "linux-x64-closure": {
        ...release.artifacts["linux-x64-closure"]!,
        sha256: hex64("other"),
      },
    };
    expect(
      codeOf(() =>
        parsed(makeManifest({ releases: [{ ...release, artifacts }] })),
      ),
    ).toBe("schema");
  });

  it("refuses a revocation dated after its manifest", () => {
    expect(
      codeOf(() =>
        parsed(
          makeManifest({
            sequence: 3,
            previous_digest: hex64("p"),
            revocations: [{ aleph: "0.5.2", reason: "synthetic", sequence: 4 }],
          }),
        ),
      ),
    ).toBe("schema");
  });
});

describe("checkManifestTransition", () => {
  const base = makeManifest();
  const baseParsed = parsed(base);
  const next = (overrides: Partial<AlephManifest>) =>
    parsed(
      makeManifest({
        sequence: 2,
        previous_digest: baseParsed.digest,
        ...overrides,
      }),
    );

  it("allows appending a release and appending a revocation", () => {
    const appended = next({
      releases: [...base.releases, makeRelease("0.5.5")],
      revocations: [{ aleph: "0.5.2", reason: "synthetic", sequence: 2 }],
    });
    expect(() => checkManifestTransition(baseParsed, appended)).not.toThrow();
  });

  it("allows a key rotation to change the signer fingerprint", () => {
    const rotated = next({ signer_fingerprint: `SHA256:${"B".repeat(43)}` });
    expect(() => checkManifestTransition(baseParsed, rotated)).not.toThrow();
  });

  it("refuses a mutated entry", () => {
    const mutated = next({
      releases: [makeRelease("0.5.4", { protocol_version: 220 })],
    });
    expect(codeOf(() => checkManifestTransition(baseParsed, mutated))).toBe(
      "release-mutated",
    );
  });

  it("refuses a removed entry", () => {
    const removed = next({ releases: [makeRelease("0.5.5")] });
    expect(codeOf(() => checkManifestTransition(baseParsed, removed))).toBe(
      "release-removed",
    );
  });

  it("refuses a duplicated entry", () => {
    expect(
      codeOf(() =>
        checkManifestTransition(
          baseParsed,
          parseManifestBytes(
            bytesOf({
              ...makeManifest({
                sequence: 2,
                previous_digest: baseParsed.digest,
              }),
              releases: [base.releases[0], base.releases[0]],
            }),
          ),
        ),
      ),
    ).toBe("schema");
  });

  it("refuses to drop or edit a revocation", () => {
    const revoked = parsed(
      makeManifest({
        sequence: 2,
        previous_digest: baseParsed.digest,
        revocations: [{ aleph: "0.5.2", reason: "synthetic", sequence: 2 }],
      }),
    );
    const dropped = parsed(
      makeManifest({
        sequence: 3,
        previous_digest: revoked.digest,
        revocations: [],
      }),
    );
    expect(codeOf(() => checkManifestTransition(revoked, dropped))).toBe(
      "revocation-removed",
    );
    const edited = parsed(
      makeManifest({
        sequence: 3,
        previous_digest: revoked.digest,
        revocations: [{ aleph: "0.5.2", reason: "changed", sequence: 2 }],
      }),
    );
    expect(codeOf(() => checkManifestTransition(revoked, edited))).toBe(
      "revocation-removed",
    );
  });

  it("refuses a revoked version appearing as a new release", () => {
    const revoked = parsed(
      makeManifest({
        sequence: 2,
        previous_digest: baseParsed.digest,
        revocations: [{ aleph: "0.5.2", reason: "synthetic", sequence: 2 }],
      }),
    );
    const resurrected = parsed(
      makeManifest({
        sequence: 3,
        previous_digest: revoked.digest,
        releases: [...base.releases, makeRelease("0.5.2")],
        revocations: revoked.manifest.revocations,
      }),
    );
    expect(codeOf(() => checkManifestTransition(revoked, resurrected))).toBe(
      "revoked-reappears",
    );
  });

  it("refuses a new revocation that claims an earlier sequence", () => {
    const backdated = next({
      revocations: [{ aleph: "0.5.2", reason: "synthetic", sequence: 1 }],
    });
    expect(codeOf(() => checkManifestTransition(baseParsed, backdated))).toBe(
      "revocation-sequence",
    );
  });

  it("refuses a broken previous_digest on a consecutive step", () => {
    const broken = parsed(
      makeManifest({ sequence: 2, previous_digest: hex64("not the digest") }),
    );
    expect(codeOf(() => checkManifestTransition(baseParsed, broken))).toBe(
      "previous-digest",
    );
  });

  it("does not walk the chain across skipped generations", () => {
    const skipped = parsed(
      makeManifest({
        sequence: 5,
        previous_digest: hex64("generation four"),
        releases: [...base.releases, makeRelease("0.5.5")],
      }),
    );
    expect(() => checkManifestTransition(baseParsed, skipped)).not.toThrow();
  });

  it("refuses a channel change and a non-increasing sequence", () => {
    const otherChannel = next({ channel: "beta" });
    expect(
      codeOf(() => checkManifestTransition(baseParsed, otherChannel)),
    ).toBe("channel");
    expect(codeOf(() => checkManifestTransition(baseParsed, baseParsed))).toBe(
      "sequence",
    );
  });
});
