import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson, digestFile } from "./aleph-build-receipt.mjs";
import {
  ALEPH_APPROVAL_NAMESPACE,
  ALEPH_PUBLISH_APPROVAL_ENV,
  ALEPH_PUBLISH_REPOSITORY,
  ALEPH_TEAM_ID,
  createSigningRunnerEnvironment,
} from "./aleph-release-policy.mjs";
import {
  createCommandRunner,
  unpublishableNameFailure,
} from "./verify-aleph-release.mjs";

const approvalPrincipal = "aleph-approver";
const signersDigestEnv = "ALEPH_APPROVAL_SIGNERS_SHA256";
const pinnedSignersPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "aleph-approval-allowed-signers",
);
const sshKeyTypePattern =
  /^(?:ssh-ed25519|sk-ssh-ed25519@openssh\.com|ssh-rsa|ecdsa-sha2-nistp\d+|sk-ecdsa-sha2-nistp256@openssh\.com)$/u;

async function assertPinnedSignersAreReal(path, expectedSha256) {
  if (!/^[0-9a-f]{64}$/u.test(expectedSha256 ?? "")) {
    throw new Error(
      `Refusing to publish: the expected sha256 of the approval signers file (${signersDigestEnv}) is missing. The digest-pinned ops recipe must supply it.`,
    );
  }
  const signersText = await readFile(path, "utf8");
  if (sha256Text(signersText) !== expectedSha256) {
    throw new Error(
      `Refusing to publish: ${path} does not match the pinned approval signers digest.`,
    );
  }
  const lines = signersText
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  const realLines = lines.filter((line) => {
    const tokens = line.replace(/namespaces="[^"]*"\s*/u, "").split(/\s+/u);
    return (
      tokens[0] === approvalPrincipal &&
      sshKeyTypePattern.test(tokens[1] ?? "") &&
      /^[A-Za-z0-9+/=]{20,}$/u.test(tokens[2] ?? "")
    );
  });
  if (realLines.length === 0 || realLines.length !== lines.length) {
    throw new Error(
      `Refusing to publish: ${path} still holds a placeholder or unrecognized entry. mk must supply the approval public key.`,
    );
  }
}

function sha256Text(text) {
  return createHash("sha256").update(text).digest("hex");
}

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function requireEqual(label, actual, expected) {
  if (actual !== expected) {
    throw new Error(
      `Approval binding mismatch: ${label} is ${String(actual)}, expected ${String(expected)}.`,
    );
  }
}

async function verifyApprovalSignature({
  allowedSignersPath,
  approvalPath,
  approvalText,
  runner,
}) {
  const result = await runner(
    "ssh-keygen",
    [
      "-Y",
      "verify",
      "-f",
      allowedSignersPath,
      "-I",
      approvalPrincipal,
      "-n",
      ALEPH_APPROVAL_NAMESPACE,
      "-s",
      `${approvalPath}.sig`,
    ],
    { input: approvalText },
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `The approval signature does not verify: ${(result.stderr || result.stdout).trim()}`,
    );
  }
}

function assertReceiptIntegrity(receipt) {
  const { receipt_id: receiptId, ...body } = receipt;
  if (receiptId !== sha256Text(canonicalJson(body))) {
    throw new Error(
      "The SignedArtifactReceipt receipt_id does not match its contents.",
    );
  }
  if (receipt.team_id !== ALEPH_TEAM_ID) {
    throw new Error(
      `The SignedArtifactReceipt team is ${receipt.team_id}, expected ${ALEPH_TEAM_ID}.`,
    );
  }
  if (
    !Array.isArray(receipt.notary) ||
    receipt.notary.length === 0 ||
    receipt.notary.some((record) => record.status !== "Accepted")
  ) {
    throw new Error("Every notary verdict in the receipt must be Accepted.");
  }
}

async function redraft(github, release) {
  try {
    await github.setDraft(release.id, true);
  } catch (error) {
    const exposed = release.assets
      .map((asset) => `${asset.name} #${asset.id} (${asset.url})`)
      .join(", ");
    throw new Error(
      `RELEASE ${release.id} IS STILL PUBLIC: re-draft failed (${error instanceof Error ? error.message : String(error)}). Exposed assets: ${exposed}. Re-draft it manually now.`,
    );
  }
}

function snapshotAssets(release) {
  return canonicalJson(
    release.assets
      .map((asset) => ({
        digest: asset.digest ?? null,
        id: asset.id,
        name: asset.name,
        size: asset.size,
      }))
      .sort((left, right) => left.id - right.id),
  );
}

async function verifyDraftAssets(github, release, tag, receipt) {
  const records = [receipt.dmg, receipt.zip];
  const approvedNames = new Set(records.map((record) => record.file));
  for (const asset of release.assets) {
    if (!approvedNames.has(asset.name)) {
      throw new Error(
        `Draft release ${tag} holds the unapproved asset ${asset.name}; refusing to make it public.`,
      );
    }
  }
  for (const record of records) {
    const matches = release.assets.filter(
      (candidate) => candidate.name === record.file,
    );
    if (matches.length !== 1) {
      throw new Error(
        `Draft release ${tag} must hold exactly one asset ${record.file}, found ${matches.length}.`,
      );
    }
    const [asset] = matches;
    if (
      asset.digest !== undefined &&
      asset.digest !== `sha256:${record.sha256}`
    ) {
      throw new Error(
        `Draft asset ${record.file} digest ${asset.digest} does not match the approved digest; nothing was published.`,
      );
    }
    const bytes = await github.downloadDraftAsset({
      assetId: asset.id,
      name: asset.name,
    });
    if (bytes.length !== record.size || sha256Bytes(bytes) !== record.sha256) {
      throw new Error(
        `Draft asset ${record.file} does not match the approved digest; nothing was published.`,
      );
    }
  }
}

async function verifyPublicAssets(github, release, receipt, tag) {
  if (release.tag !== tag) {
    throw new Error(
      `Published release ${release.id} carries tag ${String(release.tag)}, not the approved ${tag}.`,
    );
  }
  for (const record of [receipt.dmg, receipt.zip]) {
    const asset = release.assets.find(
      (candidate) => candidate.name === record.file,
    );
    if (!asset) {
      throw new Error(`Public release has no asset ${record.file}.`);
    }
    const bytes = await github.fetchPublicAsset(asset.url);
    if (bytes.length !== record.size || sha256Bytes(bytes) !== record.sha256) {
      throw new Error(
        `Public asset ${record.file} does not match the approved digest.`,
      );
    }
  }
}

export async function publishAlephRelease({
  approvalPath,
  dmgPath,
  env,
  github,
  now,
  receipt,
  expectedSignersSha256,
  runner,
  signersPath = pinnedSignersPath,
  zipPath,
}) {
  const approvedId = env[ALEPH_PUBLISH_APPROVAL_ENV]?.trim();
  if (!approvedId) {
    throw new Error(
      `Refusing to publish: ${ALEPH_PUBLISH_APPROVAL_ENV}=<approval-id> is not set.`,
    );
  }

  await assertPinnedSignersAreReal(signersPath, expectedSignersSha256);
  const approvalText = await readFile(approvalPath, "utf8");
  await verifyApprovalSignature({
    allowedSignersPath: signersPath,
    approvalPath,
    approvalText,
    runner,
  });
  const approval = JSON.parse(approvalText);
  if (approval.approval_id !== approvedId) {
    throw new Error(
      `The signed approval ${String(approval.approval_id)} is not the approval ${approvedId} named in ${ALEPH_PUBLISH_APPROVAL_ENV}.`,
    );
  }
  const validUntil = Date.parse(approval.batch_valid_until);
  if (Number.isNaN(validUntil) || now.getTime() > validUntil) {
    throw new Error(
      `The approval is past its batch_valid_until (${String(approval.batch_valid_until)}).`,
    );
  }

  assertReceiptIntegrity(receipt);
  const unpublishable = [
    ...unpublishableNameFailure(dmgPath),
    ...unpublishableNameFailure(zipPath),
    ...unpublishableNameFailure(receipt.dmg.file),
    ...unpublishableNameFailure(receipt.zip.file),
  ];
  if (unpublishable.length > 0) {
    throw new Error(`Refusing to publish: ${unpublishable.join(" ")}`);
  }
  requireEqual("version", approval.version, receipt.version);
  requireEqual("tag", approval.tag, `aleph-v${receipt.version}`);
  requireEqual("source_sha", approval.source_sha, receipt.source_sha);
  requireEqual(
    "signed_receipt_id",
    approval.signed_receipt_id,
    receipt.receipt_id,
  );
  requireEqual("dmg_sha256", approval.dmg_sha256, receipt.dmg.sha256);
  requireEqual("zip_sha256", approval.zip_sha256, receipt.zip.sha256);
  requireEqual(
    "local dmg digest",
    await digestFile(dmgPath),
    approval.dmg_sha256,
  );
  requireEqual(
    "local zip digest",
    await digestFile(zipPath),
    approval.zip_sha256,
  );

  const release = await github.getRelease(approval.tag);
  if (!release.draft) {
    throw new Error(
      `Release ${approval.tag} is not a draft; refusing to touch it.`,
    );
  }

  await verifyDraftAssets(github, release, approval.tag, receipt);

  if (release.tag !== approval.tag) {
    throw new Error(
      `Release ${release.id} carries tag ${String(release.tag)}, not the approved ${approval.tag}; nothing was published.`,
    );
  }

  const current = await github.getReleaseById(release.id);
  if (
    !current.draft ||
    current.id !== release.id ||
    current.tag !== approval.tag ||
    snapshotAssets(current) !== snapshotAssets(release)
  ) {
    throw new Error(
      `Release ${release.id} changed between verification and un-draft (assets were added or replaced, the tag moved, or the release was published); nothing was published.`,
    );
  }

  try {
    await github.setDraft(release.id, false);
    const published = await github.getReleaseById(release.id);
    if (
      published.id !== release.id ||
      snapshotAssets(published) !== snapshotAssets(current)
    ) {
      throw new Error(
        `Published release ${release.id} no longer matches the verified asset set.`,
      );
    }
    await verifyPublicAssets(github, published, receipt, approval.tag);
  } catch (error) {
    await redraft(github, current);
    throw new Error(
      `Publication check failed and the release was re-drafted: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return { approvalId: approvedId, tag: approval.tag };
}

function runBinary(command, args, env) {
  return new Promise((resolveResult) => {
    const child = spawn(command, args, {
      env: createSigningRunnerEnvironment(env),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) =>
      resolveResult({
        exitCode: 127,
        stderr: String(error.message),
        stdout: Buffer.alloc(0),
      }),
    );
    child.on("close", (code) =>
      resolveResult({
        exitCode: typeof code === "number" ? code : 1,
        stderr: Buffer.concat(stderr).toString("utf8"),
        stdout: Buffer.concat(stdout),
      }),
    );
  });
}

function toRelease(release) {
  return {
    assets: release.assets.map((asset) => ({
      digest: typeof asset.digest === "string" ? asset.digest : undefined,
      id: asset.id,
      name: asset.name,
      size: asset.size,
      url: asset.browser_download_url,
    })),
    draft: release.draft === true,
    id: release.id,
    tag: release.tag_name,
  };
}

export function createGhClient({ env = process.env, repository, runner }) {
  async function gh(args) {
    const result = await runner("gh", ["api", ...args]);
    if (result.exitCode !== 0) {
      throw new Error(
        `gh api failed: ${(result.stderr || result.stdout).trim()}`,
      );
    }
    return result.stdout;
  }
  return {
    async fetchPublicAsset(url) {
      const response = await fetch(url, { redirect: "follow" });
      if (!response.ok) {
        throw new Error(`GET ${url} returned ${response.status}`);
      }
      return Buffer.from(await response.arrayBuffer());
    },
    async downloadDraftAsset({ assetId }) {
      const result = await runBinary(
        "gh",
        [
          "api",
          "-H",
          "Accept: application/octet-stream",
          `repos/${repository}/releases/assets/${assetId}`,
        ],
        env,
      );
      if (result.exitCode !== 0) {
        throw new Error(
          `gh api asset ${assetId} failed: ${result.stderr.trim()}`,
        );
      }
      return result.stdout;
    },
    async getRelease(tag) {
      const pages = JSON.parse(
        await gh([
          "--paginate",
          "--slurp",
          `repos/${repository}/releases?per_page=100`,
        ]),
      );
      const matches = pages
        .flat()
        .filter((candidate) => candidate.tag_name === tag);
      if (matches.length !== 1) {
        throw new Error(
          `Expected exactly one release with tag ${tag} in ${repository}, found ${matches.length}.`,
        );
      }
      return toRelease(matches[0]);
    },
    async getReleaseById(id) {
      return toRelease(
        JSON.parse(await gh([`repos/${repository}/releases/${id}`])),
      );
    },
    async setDraft(id, draft) {
      await gh([
        "--method",
        "PATCH",
        `repos/${repository}/releases/${id}`,
        "-F",
        `draft=${draft ? "true" : "false"}`,
      ]);
    },
  };
}

function readFlag(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

async function main() {
  const args = process.argv.slice(2);
  const approval = readFlag(args, "--approval");
  const receiptPath = readFlag(args, "--receipt");
  const dmg = readFlag(args, "--dmg");
  const zip = readFlag(args, "--zip");
  if (args.some((arg) => /allowed-signers|signers/u.test(arg))) {
    throw new Error(
      `The approval signers file is pinned by ${signersDigestEnv}; it cannot be overridden.`,
    );
  }
  if (!approval || !receiptPath || !dmg || !zip) {
    throw new Error(
      "Usage: publish-release.mjs --approval <file> --receipt <SignedArtifactReceipt.json> --dmg <file> --zip <file>",
    );
  }
  const runner = createCommandRunner(
    createSigningRunnerEnvironment(process.env),
  );
  const result = await publishAlephRelease({
    approvalPath: resolve(approval),
    dmgPath: resolve(dmg),
    env: process.env,
    expectedSignersSha256: process.env[signersDigestEnv]?.trim(),
    github: createGhClient({
      repository: ALEPH_PUBLISH_REPOSITORY,
      runner,
    }),
    now: new Date(),
    receipt: JSON.parse(await readFile(receiptPath, "utf8")),
    runner,
    zipPath: resolve(zip),
  });
  console.log(`Published ${result.tag} under approval ${result.approvalId}.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
