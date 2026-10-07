import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AlephManifestError } from "./aleph-manifest.js";

export const MANIFEST_SIGNATURE_NAMESPACE = "aleph-update-manifest";
export const MANIFEST_SIGNER_IDENTITY = "aleph-update";
const SK_KEY_TYPE = "sk-ssh-ed25519@openssh.com";
const FLAG_USER_PRESENT = 0x01;
const FLAG_USER_VERIFIED = 0x04;
const VERIFY_TIMEOUT_MS = 30_000;

export interface AllowedSigner {
  validAfter: string;
  validBefore: string | undefined;
  publicKeyLine: string;
  fingerprint: string;
}

const ALLOWED_SIGNERS_LINE = new RegExp(
  `^${MANIFEST_SIGNER_IDENTITY} namespaces="${MANIFEST_SIGNATURE_NAMESPACE}",` +
    `valid-after="(\\d{8})"(?:,valid-before="(\\d{8})")? ` +
    `(${SK_KEY_TYPE.replace(/\./gu, "\\.")} ([A-Za-z0-9+/]+={0,2}))$`,
  "u",
);

function fingerprintOf(blob: Buffer): string {
  return `SHA256:${createHash("sha256").update(blob).digest("base64").replace(/=+$/u, "")}`;
}

class Reader {
  private offset = 0;
  constructor(private readonly bytes: Buffer) {}

  raw(length: number): Buffer {
    if (length < 0 || this.offset + length > this.bytes.length) {
      throw new Error("truncated");
    }
    const out = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return out;
  }

  u32(): number {
    return this.raw(4).readUInt32BE();
  }

  string(): Buffer {
    return this.raw(this.u32());
  }

  get done(): boolean {
    return this.offset === this.bytes.length;
  }
}

export function parseAllowedSigners(text: string): AllowedSigner[] {
  const signers: AllowedSigner[] = [];
  for (const [index, line] of text.split("\n").entries()) {
    if (line === "" || line.startsWith("#")) continue;
    const match = ALLOWED_SIGNERS_LINE.exec(line);
    if (match === null) {
      throw new AlephManifestError(
        "allowed-signers-invalid",
        `allowed_signers line ${index + 1} is not in the accepted form`,
      );
    }
    const blob = Buffer.from(match[4] ?? "", "base64");
    let embeddedType: string;
    try {
      embeddedType = new Reader(blob).string().toString("utf8");
    } catch {
      embeddedType = "";
    }
    if (embeddedType !== SK_KEY_TYPE) {
      throw new AlephManifestError(
        "allowed-signers-invalid",
        `allowed_signers line ${index + 1} does not hold a security-key public key`,
      );
    }
    signers.push({
      validAfter: match[1] ?? "",
      validBefore: match[2],
      publicKeyLine: match[3] ?? "",
      fingerprint: fingerprintOf(blob),
    });
  }
  if (signers.length === 0) {
    throw new AlephManifestError(
      "allowed-signers-invalid",
      "allowed_signers lists no signer",
    );
  }
  return signers;
}

interface ParsedSignature {
  keyType: string;
  namespace: string;
  flags: number | undefined;
}

const ARMOR_BEGIN = "-----BEGIN SSH SIGNATURE-----\n";
const ARMOR_END = "-----END SSH SIGNATURE-----";

function parseSignatureArmor(armored: string): ParsedSignature {
  const malformed = () =>
    new AlephManifestError(
      "signature-malformed",
      "signature is not an SSH signature",
    );
  if (!armored.startsWith(ARMOR_BEGIN)) throw malformed();
  const endAt = armored.indexOf(ARMOR_END, ARMOR_BEGIN.length);
  if (endAt === -1 || armored.slice(endAt + ARMOR_END.length).trim() !== "")
    throw malformed();
  const body = armored.slice(ARMOR_BEGIN.length, endAt).replace(/\n/gu, "");
  if (body === "" || !/^[A-Za-z0-9+/]+={0,2}$/u.test(body)) throw malformed();
  try {
    const reader = new Reader(Buffer.from(body, "base64"));
    if (reader.raw(6).toString("latin1") !== "SSHSIG" || reader.u32() !== 1)
      throw malformed();
    const keyType = new Reader(reader.string()).string().toString("utf8");
    const namespace = reader.string().toString("utf8");
    reader.string();
    reader.string();
    const signature = new Reader(reader.string());
    const signatureType = signature.string().toString("utf8");
    signature.string();
    let flags: number | undefined;
    if (signatureType === SK_KEY_TYPE) {
      flags = signature.raw(1)[0];
      signature.u32();
    }
    if (!reader.done || !signature.done) throw malformed();
    return { keyType, namespace, flags };
  } catch (error) {
    if (error instanceof AlephManifestError) throw error;
    throw malformed();
  }
}

function verifyTime(now: Date): string {
  return `${now.toISOString().slice(0, 19).replace(/[-:T]/gu, "")}Z`;
}

function runSshKeygen(
  command: string,
  args: string[],
  stdin: Buffer,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LC_ALL: "C" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), VERIFY_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(stdin);
  });
}

export async function verifyManifestSignature(args: {
  manifestBytes: string | Uint8Array;
  signature: string;
  allowedSigners: string;
  expectedFingerprint: string;
  now: Date;
  sshKeygen?: string;
}): Promise<{ fingerprint: string }> {
  parseAllowedSigners(args.allowedSigners);
  const parsed = parseSignatureArmor(args.signature);
  if (parsed.keyType !== SK_KEY_TYPE) {
    throw new AlephManifestError(
      "signature-key-type",
      "signature was not made by a security key",
    );
  }
  if (parsed.namespace !== MANIFEST_SIGNATURE_NAMESPACE) {
    throw new AlephManifestError(
      "signature-namespace",
      "signature is for another namespace",
    );
  }
  const required = FLAG_USER_PRESENT | FLAG_USER_VERIFIED;
  if (parsed.flags === undefined || (parsed.flags & required) !== required) {
    throw new AlephManifestError(
      "signature-flags",
      "signature lacks the user-presence or user-verification flag",
    );
  }
  const dir = await mkdtemp(join(tmpdir(), "aleph-verify-"));
  try {
    const signersPath = join(dir, "allowed_signers");
    const signaturePath = join(dir, "manifest.sig");
    await writeFile(signersPath, args.allowedSigners, { mode: 0o600 });
    await writeFile(signaturePath, args.signature, { mode: 0o600 });
    const input =
      typeof args.manifestBytes === "string"
        ? Buffer.from(args.manifestBytes, "utf8")
        : Buffer.from(args.manifestBytes);
    let result: Awaited<ReturnType<typeof runSshKeygen>>;
    try {
      result = await runSshKeygen(
        args.sshKeygen ?? "ssh-keygen",
        [
          "-Y",
          "verify",
          "-f",
          signersPath,
          "-I",
          MANIFEST_SIGNER_IDENTITY,
          "-n",
          MANIFEST_SIGNATURE_NAMESPACE,
          "-s",
          signaturePath,
          `-Overify-time=${verifyTime(args.now)}`,
        ],
        input,
      );
    } catch {
      throw new AlephManifestError(
        "ssh-keygen-unavailable",
        "ssh-keygen could not be run",
      );
    }
    const reported =
      /^Good "aleph-update-manifest" signature for aleph-update with ED25519-SK key (SHA256:[A-Za-z0-9+/]{43})$/mu.exec(
        result.stdout,
      )?.[1];
    if (result.code !== 0 || reported === undefined) {
      throw new AlephManifestError(
        "signature-invalid",
        "signature did not verify",
      );
    }
    if (reported !== args.expectedFingerprint) {
      throw new AlephManifestError(
        "signer-mismatch",
        "signing key is not the fingerprint the manifest declares",
      );
    }
    return { fingerprint: reported };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
