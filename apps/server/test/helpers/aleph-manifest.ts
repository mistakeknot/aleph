import { createHash } from "node:crypto";
import type {
  AlephManifest,
  AlephManifestRelease,
} from "@bb/config/aleph-manifest";

export const SYNTHETIC_FINGERPRINT = `SHA256:${"A".repeat(43)}`;

export function hex64(seed: string): string {
  return createHash("sha256").update(seed).digest("hex");
}

export function makeRelease(
  aleph = "0.5.4",
  overrides: Partial<AlephManifestRelease> = {},
): AlephManifestRelease {
  const archive = hex64(`archive-${aleph}`);
  return {
    aleph,
    version: `0.44.0+aleph.${aleph}`,
    upstream_base: "0.44.0",
    repo_id: 1000000001,
    source_sha: hex64(`source-${aleph}`).slice(0, 40),
    recipe: "release-closure/1",
    toolchain: {
      node: "22.1.0",
      npm: "11.16.0",
      pnpm: "9.15.0",
      glibc: "2.39",
    },
    protocol_version: 219,
    db: {
      migrations: [
        { tag: "0001_first", when: 1759000000000, sha256: hex64("m1") },
        { tag: "0002_second", when: 1759000100000, sha256: hex64("m2") },
      ],
    },
    qualification: {
      jobs: [
        { id: 101, attempt: 1 },
        { id: 102, attempt: 1 },
      ],
      archive_sha256: archive,
      tree_sha256: hex64(`tree-${aleph}`),
      node_abi: "127",
      glibc: "2.39",
      bins: ["bb", "bb-app", "bb-host-daemon", "bb-server"],
    },
    review: { kind: "cross-lab", receipt_sha256: hex64(`review-${aleph}`) },
    artifacts: {
      "linux-x64-closure": {
        file: `aleph-${aleph}-linux-x64.tar`,
        sha256: archive,
        size: 1234,
      },
      "darwin-arm64": {
        file: `Aleph-${aleph}-arm64.zip`,
        sha256: hex64(`zip-${aleph}`),
        size: 4321,
        attestation: "maintainer-receipt",
        receipt_sha256: hex64(`receipt-${aleph}`),
      },
    },
    ...overrides,
  };
}

export function makeManifest(
  overrides: Partial<AlephManifest> = {},
): AlephManifest {
  return {
    schema: "aleph-manifest/2",
    channel: "stable",
    sequence: 1,
    previous_digest: null,
    issued_at: "2026-10-06T12:00:00Z",
    expires_at: "2026-11-05T12:00:00Z",
    signer_fingerprint: SYNTHETIC_FINGERPRINT,
    releases: [makeRelease("0.5.4")],
    revocations: [],
    ...overrides,
  };
}
