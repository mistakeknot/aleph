import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { AlephManifestError, canonicalJson } from "../src/aleph-manifest.js";
import {
  parseAllowedSigners,
  verifyManifestSignature,
} from "../src/aleph-manifest-signature.js";
import { FakeSecurityKey, makeManifest } from "./aleph-manifest-fixtures.js";

const NOW = new Date("2026-10-10T00:00:00Z");
const scratch = mkdtempSync(join(tmpdir(), "aleph-manifest-sig-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const key = new FakeSecurityKey();

function manifestFor(signer: FakeSecurityKey): string {
  return canonicalJson(
    makeManifest({ signer_fingerprint: signer.fingerprint }),
  );
}

async function codeOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    if (error instanceof AlephManifestError) return error.code;
    throw error;
  }
  return "no-error";
}

describe("verifyManifestSignature", () => {
  it("verifies a good security-key signature and reports the fingerprint", async () => {
    const bytes = manifestFor(key);
    const result = await verifyManifestSignature({
      manifestBytes: bytes,
      signature: key.sign(bytes),
      allowedSigners: key.allowedSigners(),
      expectedFingerprint: key.fingerprint,
      now: NOW,
    });
    expect(result.fingerprint).toBe(key.fingerprint);
  });

  it("refuses a signature over different bytes", async () => {
    const bytes = manifestFor(key);
    expect(
      await codeOf(() =>
        verifyManifestSignature({
          manifestBytes: `${bytes} `,
          signature: key.sign(bytes),
          allowedSigners: key.allowedSigners(),
          expectedFingerprint: key.fingerprint,
          now: NOW,
        }),
      ),
    ).toBe("signature-invalid");
  });

  it("refuses the wrong namespace", async () => {
    const bytes = manifestFor(key);
    expect(
      await codeOf(() =>
        verifyManifestSignature({
          manifestBytes: bytes,
          signature: key.sign(bytes, { namespace: "file" }),
          allowedSigners: key.allowedSigners(),
          expectedFingerprint: key.fingerprint,
          now: NOW,
        }),
      ),
    ).toBe("signature-namespace");
  });

  it("refuses an attacker key that is not in allowed_signers", async () => {
    const attacker = new FakeSecurityKey();
    const bytes = manifestFor(attacker);
    expect(
      await codeOf(() =>
        verifyManifestSignature({
          manifestBytes: bytes,
          signature: attacker.sign(bytes),
          allowedSigners: key.allowedSigners(),
          expectedFingerprint: attacker.fingerprint,
          now: NOW,
        }),
      ),
    ).toBe("signature-invalid");
  });

  it("refuses a signature without the user-presence or verification flag", async () => {
    const bytes = manifestFor(key);
    for (const flags of [0x00, 0x04, 0x01]) {
      expect(
        await codeOf(() =>
          verifyManifestSignature({
            manifestBytes: bytes,
            signature: key.sign(bytes, { flags }),
            allowedSigners: key.allowedSigners(),
            expectedFingerprint: key.fingerprint,
            now: NOW,
          }),
        ),
      ).toBe("signature-flags");
    }
  });

  it("refuses a fingerprint that differs from the manifest's", async () => {
    const bytes = manifestFor(key);
    expect(
      await codeOf(() =>
        verifyManifestSignature({
          manifestBytes: bytes,
          signature: key.sign(bytes),
          allowedSigners: key.allowedSigners(),
          expectedFingerprint: `SHA256:${"B".repeat(43)}`,
          now: NOW,
        }),
      ),
    ).toBe("signer-mismatch");
  });

  it("refuses a key that is past valid-before and one not yet valid", async () => {
    const bytes = manifestFor(key);
    const base = {
      manifestBytes: bytes,
      signature: key.sign(bytes),
      expectedFingerprint: key.fingerprint,
      now: NOW,
    };
    expect(
      await codeOf(() =>
        verifyManifestSignature({
          ...base,
          allowedSigners: key.allowedSigners({ validBefore: "20261001" }),
        }),
      ),
    ).toBe("signature-invalid");
    expect(
      await codeOf(() =>
        verifyManifestSignature({
          ...base,
          allowedSigners: key.allowedSigners({ validAfter: "20261011" }),
        }),
      ),
    ).toBe("signature-invalid");
    expect(
      await codeOf(() =>
        verifyManifestSignature({
          ...base,
          allowedSigners: key.allowedSigners({ validBefore: "20261011" }),
        }),
      ),
    ).toBe("no-error");
  });

  it("accepts either key during a rotation window", async () => {
    const successor = new FakeSecurityKey();
    const bytes = manifestFor(successor);
    const allowedSigners =
      key.allowedSigners({ validBefore: "20261201" }) +
      successor.allowedSigners({ validAfter: "20261001" });
    const result = await verifyManifestSignature({
      manifestBytes: bytes,
      signature: successor.sign(bytes),
      allowedSigners,
      expectedFingerprint: successor.fingerprint,
      now: NOW,
    });
    expect(result.fingerprint).toBe(successor.fingerprint);
  });

  it("refuses a non-security-key signature made by real ssh-keygen", async () => {
    const dir = mkdtempSync(join(scratch, "plain-"));
    const keyPath = join(dir, "key");
    execFileSync("ssh-keygen", [
      "-q",
      "-t",
      "ed25519",
      "-N",
      "",
      "-f",
      keyPath,
    ]);
    const bytes = canonicalJson(makeManifest());
    const manifestPath = join(dir, "manifest.json");
    writeFileSync(manifestPath, bytes);
    execFileSync("ssh-keygen", [
      "-Y",
      "sign",
      "-f",
      keyPath,
      "-n",
      "aleph-update-manifest",
      manifestPath,
    ]);
    const { readFileSync } = await import("node:fs");
    const signature = readFileSync(`${manifestPath}.sig`, "utf8");
    const publicKey = readFileSync(`${keyPath}.pub`, "utf8").trim().split(" ");
    const allowedSigners = `aleph-update namespaces="aleph-update-manifest",valid-after="20260101" ${publicKey[0]} ${publicKey[1]}\n`;
    expect(
      await codeOf(() =>
        verifyManifestSignature({
          manifestBytes: bytes,
          signature,
          allowedSigners,
          expectedFingerprint: "SHA256:irrelevant",
          now: NOW,
        }),
      ),
    ).toBe("allowed-signers-invalid");
    expect(
      await codeOf(() =>
        verifyManifestSignature({
          manifestBytes: bytes,
          signature,
          allowedSigners: key.allowedSigners(),
          expectedFingerprint: "SHA256:irrelevant",
          now: NOW,
        }),
      ),
    ).toBe("signature-key-type");
  });

  it("refuses malformed signature armor", async () => {
    const bytes = manifestFor(key);
    for (const signature of [
      "",
      "garbage",
      "-----BEGIN SSH SIGNATURE-----\n!!\n-----END SSH SIGNATURE-----\n",
    ]) {
      expect(
        await codeOf(() =>
          verifyManifestSignature({
            manifestBytes: bytes,
            signature,
            allowedSigners: key.allowedSigners(),
            expectedFingerprint: key.fingerprint,
            now: NOW,
          }),
        ),
      ).toBe("signature-malformed");
    }
  });
});

describe("parseAllowedSigners", () => {
  const line = (options: string, keyField = key.publicKeyLine) =>
    `aleph-update ${options} ${keyField}\n`;
  const valid = 'namespaces="aleph-update-manifest",valid-after="20260101"';

  it("accepts only the documented line form", () => {
    expect(parseAllowedSigners(line(valid))).toHaveLength(1);
    expect(
      parseAllowedSigners(
        `# note\n\n${line(valid)}${line(`${valid},valid-before="20270101"`)}`,
      ),
    ).toHaveLength(2);
  });

  it.each([
    ["wrong principal", `other ${valid} ${key.publicKeyLine}\n`],
    ["no namespaces option", line('valid-after="20260101"')],
    ["wildcard namespaces", line('namespaces="*",valid-after="20260101"')],
    [
      "extra namespace",
      line('namespaces="aleph-update-manifest,file",valid-after="20260101"'),
    ],
    ["no valid-after", line('namespaces="aleph-update-manifest"')],
    ["cert-authority", line(`cert-authority,${valid}`)],
    ["no-touch-required", line(`no-touch-required,${valid}`)],
    [
      "bad date",
      line('namespaces="aleph-update-manifest",valid-after="2026-01-01"'),
    ],
    [
      "plain ed25519",
      line(
        valid,
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      ),
    ],
    [
      "trailing comment",
      `aleph-update ${valid} ${key.publicKeyLine} comment\n`,
    ],
    ["no key", `aleph-update ${valid}\n`],
    ["empty file", "\n# only a comment\n"],
  ])("refuses %s", (_name, text) => {
    expect(() => parseAllowedSigners(text)).toThrow(AlephManifestError);
  });
});
