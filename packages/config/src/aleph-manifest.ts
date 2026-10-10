import { createHash } from "node:crypto";
import { z } from "zod";
import { alephReleaseVersion } from "./aleph-version.js";

export const ALEPH_MANIFEST_SCHEMA = "aleph-manifest/2";

export type AlephManifestErrorCode =
  | "malformed"
  | "non-canonical"
  | "schema"
  | "channel"
  | "sequence"
  | "previous-digest"
  | "release-removed"
  | "release-mutated"
  | "revocation-removed"
  | "revocation-sequence"
  | "revoked-reappears"
  | "sequence-conflict"
  | "sequence-below-floor"
  | "issued-before-floor"
  | "issued-in-future"
  | "clock-rollback"
  | "expired"
  | "validity-too-long"
  | "state-corrupt"
  | "state-locked"
  | "allowed-signers-invalid"
  | "signature-malformed"
  | "signature-key-type"
  | "signature-namespace"
  | "signature-flags"
  | "signature-invalid"
  | "signer-mismatch"
  | "ssh-keygen-unavailable";

export class AlephManifestError extends Error {
  constructor(
    readonly code: AlephManifestErrorCode,
    message: string,
    readonly escalate = false,
  ) {
    super(message);
    this.name = "AlephManifestError";
  }
}

const HEX_64 = /^[0-9a-f]{64}$/u;
const HEX_40 = /^[0-9a-f]{40}$/u;
const PART = "(?:0|[1-9][0-9]{0,3})";
const ALEPH_VERSION = new RegExp(`^${PART}\\.${PART}\\.${PART}$`, "u");
const SEMVER_BASE = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u;
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/u;

const hex64 = z.string().regex(HEX_64);
const positiveInt = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const timestamp = z.string().refine((value) => {
  if (!TIMESTAMP.test(value)) return false;
  const parsed = new Date(value);
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().replace(".000Z", "Z") === value
  );
}, "expected a UTC timestamp like 2026-01-02T03:04:05Z");
const alephVersion = z.string().regex(ALEPH_VERSION);
const token = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/u);

const migrationSchema = z.strictObject({
  tag: z.string().min(1).max(200),
  when: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  sha256: hex64,
});

const linuxArtifactSchema = z.strictObject({
  file: z.string().regex(FILE_NAME),
  sha256: hex64,
  size: positiveInt,
});

const macArtifactSchema = z.strictObject({
  file: z.string().regex(FILE_NAME),
  sha256: hex64,
  size: positiveInt,
  attestation: z.literal("maintainer-receipt"),
  receipt_sha256: hex64,
});

const releaseSchema = z.strictObject({
  aleph: alephVersion,
  version: z.string().min(1).max(100),
  upstream_base: z.string().regex(SEMVER_BASE),
  repo_id: positiveInt,
  source_sha: z.string().regex(HEX_40),
  recipe: z.string().regex(/^[a-z][a-z0-9-]*\/[0-9]+$/u),
  toolchain: z.strictObject({
    node: token,
    npm: token,
    pnpm: token,
    glibc: token,
  }),
  protocol_version: positiveInt,
  db: z.strictObject({ migrations: z.array(migrationSchema) }),
  qualification: z.strictObject({
    jobs: z
      .array(z.strictObject({ id: positiveInt, attempt: positiveInt }))
      .min(2),
    archive_sha256: hex64,
    tree_sha256: hex64,
    node_abi: token,
    glibc: token,
    bins: z.array(token).min(1),
  }),
  review: z.strictObject({ kind: token, receipt_sha256: hex64 }),
  artifacts: z
    .strictObject({
      "linux-x64-closure": linuxArtifactSchema.optional(),
      "darwin-arm64": macArtifactSchema.optional(),
    })
    .refine(
      (artifacts) =>
        artifacts["linux-x64-closure"] !== undefined ||
        artifacts["darwin-arm64"] !== undefined,
      "a release needs at least one artifact",
    ),
});

const revocationSchema = z.strictObject({
  aleph: alephVersion,
  reason: z.string().min(1).max(500),
  sequence: positiveInt,
});

const manifestSchema = z
  .strictObject({
    schema: z.literal(ALEPH_MANIFEST_SCHEMA),
    channel: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/u),
    sequence: positiveInt,
    previous_digest: hex64.nullable(),
    issued_at: timestamp,
    expires_at: timestamp,
    signer_fingerprint: z.string().regex(/^SHA256:[A-Za-z0-9+/]{43}$/u),
    releases: z.array(releaseSchema).min(1),
    revocations: z.array(revocationSchema),
  })
  .superRefine((manifest, ctx) => {
    const issue = (message: string) =>
      ctx.addIssue({ code: "custom", message });
    if (
      manifest.sequence === 1
        ? manifest.previous_digest !== null
        : manifest.previous_digest === null
    ) {
      issue("previous_digest is null exactly for sequence 1");
    }
    if (manifest.expires_at <= manifest.issued_at) {
      issue("expires_at must be after issued_at");
    }
    const seen = new Set<string>();
    for (const release of manifest.releases) {
      if (seen.has(release.aleph)) issue(`duplicate release ${release.aleph}`);
      seen.add(release.aleph);
      if (alephReleaseVersion(release.version) !== release.aleph) {
        issue(
          `release ${release.aleph}: version does not carry that aleph release`,
        );
      }
      if (release.version.split("+")[0] !== release.upstream_base) {
        issue(`release ${release.aleph}: upstream_base does not match version`);
      }
      const tags = new Set<string>();
      for (const migration of release.db.migrations) {
        if (tags.has(migration.tag))
          issue(
            `release ${release.aleph}: duplicate migration ${migration.tag}`,
          );
        tags.add(migration.tag);
      }
      const linux = release.artifacts["linux-x64-closure"];
      if (
        linux !== undefined &&
        linux.sha256 !== release.qualification.archive_sha256
      ) {
        issue(
          `release ${release.aleph}: linux artifact is not the qualified archive`,
        );
      }
    }
    const revoked = new Set<string>();
    for (const revocation of manifest.revocations) {
      if (revoked.has(revocation.aleph))
        issue(`duplicate revocation ${revocation.aleph}`);
      revoked.add(revocation.aleph);
      if (revocation.sequence > manifest.sequence) {
        issue(`revocation ${revocation.aleph} is dated after this manifest`);
      }
    }
  });

export type AlephManifest = z.infer<typeof manifestSchema>;
export type AlephManifestRelease = z.infer<typeof releaseSchema>;

export interface ParsedManifest {
  manifest: AlephManifest;
  digest: string;
  bytes: string;
}

export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "number":
      if (!Number.isSafeInteger(value)) {
        throw new Error("canonical JSON carries safe integers only");
      }
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) {
        return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
      }
      const record = value as Record<string, unknown>;
      const members = Object.keys(record)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
      return `{${members.join(",")}}`;
    }
    default:
      throw new Error(`canonical JSON cannot carry a ${typeof value}`);
  }
}

export function manifestDigest(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function parseManifestBytes(input: string | Uint8Array): ParsedManifest {
  let text: string;
  if (typeof input === "string") {
    text = input;
  } else {
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        input,
      );
    } catch {
      throw new AlephManifestError("malformed", "manifest is not valid UTF-8");
    }
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new AlephManifestError("malformed", "manifest is not valid JSON");
  }
  const result = manifestSchema.safeParse(value);
  if (!result.success) {
    const first = result.error.issues[0];
    const where = first?.path.join(".") ?? "";
    throw new AlephManifestError(
      "schema",
      `manifest violates the schema${where === "" ? "" : ` at ${where}`}: ${first?.message ?? "invalid"}`,
    );
  }
  if (canonicalJson(value) !== text) {
    throw new AlephManifestError(
      "non-canonical",
      "manifest bytes are not canonical JSON",
    );
  }
  return { manifest: result.data, digest: manifestDigest(text), bytes: text };
}

export function checkManifestTransition(
  previous: ParsedManifest,
  next: ParsedManifest,
): void {
  const before = previous.manifest;
  const after = next.manifest;
  if (before.channel !== after.channel) {
    throw new AlephManifestError("channel", "manifest changes channel");
  }
  if (after.sequence <= before.sequence) {
    throw new AlephManifestError(
      "sequence",
      "manifest does not advance the sequence",
    );
  }
  if (
    after.sequence === before.sequence + 1 &&
    after.previous_digest !== previous.digest
  ) {
    throw new AlephManifestError(
      "previous-digest",
      "previous_digest does not match the preceding manifest",
    );
  }
  const nextReleases = new Map(
    after.releases.map((release) => [release.aleph, release]),
  );
  for (const release of before.releases) {
    const counterpart = nextReleases.get(release.aleph);
    if (counterpart === undefined) {
      throw new AlephManifestError(
        "release-removed",
        `release ${release.aleph} was removed`,
      );
    }
    if (canonicalJson(counterpart) !== canonicalJson(release)) {
      throw new AlephManifestError(
        "release-mutated",
        `release ${release.aleph} was changed`,
      );
    }
  }
  const nextRevocations = new Map(
    after.revocations.map((entry) => [entry.aleph, entry]),
  );
  for (const revocation of before.revocations) {
    const counterpart = nextRevocations.get(revocation.aleph);
    if (
      counterpart === undefined ||
      canonicalJson(counterpart) !== canonicalJson(revocation)
    ) {
      throw new AlephManifestError(
        "revocation-removed",
        `revocation of ${revocation.aleph} was removed or changed`,
      );
    }
  }
  const consecutive = after.sequence === before.sequence + 1;
  const previousRevoked = new Set(
    before.revocations.map((entry) => entry.aleph),
  );
  for (const revocation of after.revocations) {
    if (previousRevoked.has(revocation.aleph)) continue;
    const introducedAt = consecutive
      ? revocation.sequence === after.sequence
      : revocation.sequence > before.sequence &&
        revocation.sequence <= after.sequence;
    if (!introducedAt) {
      throw new AlephManifestError(
        "revocation-sequence",
        consecutive
          ? `new revocation of ${revocation.aleph} must carry this manifest's sequence`
          : `new revocation of ${revocation.aleph} must be introduced after the cached sequence`,
      );
    }
  }
  const previousReleases = new Set(
    before.releases.map((release) => release.aleph),
  );
  for (const release of after.releases) {
    if (previousReleases.has(release.aleph)) continue;
    const revocation = nextRevocations.get(release.aleph);
    if (revocation === undefined) continue;
    if (consecutive || previousRevoked.has(release.aleph)) {
      throw new AlephManifestError(
        "revoked-reappears",
        `revoked release ${release.aleph} appears as a new entry`,
      );
    }
  }
}
