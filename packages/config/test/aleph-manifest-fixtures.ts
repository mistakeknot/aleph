import {
  createHash,
  createPrivateKey,
  generateKeyPairSync,
  sign as cryptoSign,
  type KeyObject,
} from "node:crypto";
import type {
  AlephManifest,
  AlephManifestRelease,
} from "../src/aleph-manifest.js";

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

function sshString(value: Buffer | string): Buffer {
  const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : value;
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  return Buffer.concat([length, bytes]);
}

const SK_TYPE = "sk-ssh-ed25519@openssh.com";

export class FakeSecurityKey {
  readonly publicBlob: Buffer;
  readonly publicKeyLine: string;
  readonly fingerprint: string;
  private readonly privateKey: KeyObject;

  constructor(readonly application = "ssh:aleph-update") {
    const pair = generateKeyPairSync("ed25519");
    this.privateKey = createPrivateKey(
      pair.privateKey.export({ format: "pem", type: "pkcs8" }),
    );
    const jwk = pair.publicKey.export({ format: "jwk" });
    const raw = Buffer.from(String(jwk.x), "base64url");
    this.publicBlob = Buffer.concat([
      sshString(SK_TYPE),
      sshString(raw),
      sshString(application),
    ]);
    this.publicKeyLine = `${SK_TYPE} ${this.publicBlob.toString("base64")}`;
    this.fingerprint = `SHA256:${createHash("sha256")
      .update(this.publicBlob)
      .digest("base64")
      .replace(/=+$/u, "")}`;
  }

  allowedSigners(
    options: {
      validAfter?: string;
      validBefore?: string;
      namespaces?: string;
    } = {},
  ): string {
    const parts = [
      `namespaces="${options.namespaces ?? "aleph-update-manifest"}"`,
      `valid-after="${options.validAfter ?? "20260101"}"`,
    ];
    if (options.validBefore !== undefined)
      parts.push(`valid-before="${options.validBefore}"`);
    return `aleph-update ${parts.join(",")} ${this.publicKeyLine}\n`;
  }

  sign(
    message: Buffer | string,
    options: { namespace?: string; flags?: number; counter?: number } = {},
  ): string {
    const namespace = options.namespace ?? "aleph-update-manifest";
    const flags = options.flags ?? 0x05;
    const counter = options.counter ?? 7;
    const messageBytes =
      typeof message === "string" ? Buffer.from(message, "utf8") : message;
    const hashed = createHash("sha512").update(messageBytes).digest();
    const signedData = Buffer.concat([
      Buffer.from("SSHSIG", "latin1"),
      sshString(namespace),
      sshString(""),
      sshString("sha512"),
      sshString(hashed),
    ]);
    const counterBytes = Buffer.alloc(4);
    counterBytes.writeUInt32BE(counter);
    const skSigned = Buffer.concat([
      createHash("sha256").update(this.application).digest(),
      Buffer.from([flags]),
      counterBytes,
      createHash("sha256").update(signedData).digest(),
    ]);
    const rawSignature = cryptoSign(null, skSigned, this.privateKey);
    const signatureField = Buffer.concat([
      sshString(SK_TYPE),
      sshString(rawSignature),
      Buffer.from([flags]),
      counterBytes,
    ]);
    const version = Buffer.alloc(4);
    version.writeUInt32BE(1);
    const blob = Buffer.concat([
      Buffer.from("SSHSIG", "latin1"),
      version,
      sshString(this.publicBlob),
      sshString(namespace),
      sshString(""),
      sshString("sha512"),
      sshString(signatureField),
    ]);
    const body =
      blob
        .toString("base64")
        .match(/.{1,70}/gu)
        ?.join("\n") ?? "";
    return `-----BEGIN SSH SIGNATURE-----\n${body}\n-----END SSH SIGNATURE-----\n`;
  }
}
