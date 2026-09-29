import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJson } from "../scripts/aleph-build-receipt.mjs";
import { createCommandRunner } from "../scripts/verify-aleph-release.mjs";
import { publishAlephRelease } from "../scripts/publish-release.mjs";
import type { SignedArtifactReceipt } from "../scripts/sign-aleph-release.mjs";
import {
  createRunner,
  fail,
  type Overrides,
} from "./helpers/aleph-fake-runner.js";

const temporaryDirectories: string[] = [];
const sourceSha = "3e7e1a3b4750e67f9af1f60efed1900111740413";
const dmgBytes = Buffer.from("dmg-bytes");
const zipBytes = Buffer.from("zip-bytes");

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

type GithubCall = string;

async function createFixture(
  changes: {
    approval?: Record<string, unknown>;
    receipt?: Record<string, unknown>;
    releaseDraft?: boolean;
    draftZip?: Buffer;
    servedZip?: Buffer;
    extraAsset?: boolean;
    replaceZipAfterDownload?: boolean;
    dmgFile?: string;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "aleph-publish-"));
  temporaryDirectories.push(root);
  const receiptBody = {
    build_receipt_digest: "b".repeat(64),
    bundle_id: "com.generalsystemsventures.aleph",
    dmg: {
      file: "Aleph-0.5.0-arm64.dmg",
      sha256: sha256(dmgBytes),
      size: dmgBytes.length,
    },
    entitlements_sha256: "c".repeat(64),
    notary: [
      { status: "Accepted", submission_id: "s1", target: "app" },
      { status: "Accepted", submission_id: "s2", target: "dmg" },
    ],
    schema: "aleph-signed-artifact-receipt/1",
    source_sha: sourceSha,
    team_id: "W964996768",
    version: "0.5.0",
    zip: {
      file: "Aleph-0.5.0-arm64.zip",
      sha256: sha256(zipBytes),
      size: zipBytes.length,
    },
    ...changes.receipt,
  };
  const receipt = {
    ...receiptBody,
    receipt_id: sha256(Buffer.from(canonicalJson(receiptBody))),
  } as SignedArtifactReceipt;
  const approval = {
    approval_id: "apr-1",
    batch_valid_until: "2026-10-01T00:00:00Z",
    dmg_sha256: sha256(dmgBytes),
    schema: "aleph-publish-approval/1",
    signed_receipt_id: receipt.receipt_id,
    source_sha: sourceSha,
    tag: "aleph-v0.5.0",
    version: "0.5.0",
    zip_sha256: sha256(zipBytes),
    ...changes.approval,
  };
  const dmgPath = join(root, "Aleph-0.5.0-arm64.dmg");
  const zipPath = join(root, "Aleph-0.5.0-arm64.zip");
  const approvalPath = join(root, "approval.json");
  await writeFile(dmgPath, dmgBytes);
  await writeFile(zipPath, zipBytes);
  await writeFile(approvalPath, JSON.stringify(approval));
  await writeFile(`${approvalPath}.sig`, "signature");
  const allowedSignersPath = join(root, "allowed_signers");
  await writeFile(
    allowedSignersPath,
    `aleph-approver namespaces="aleph-approval" ssh-ed25519 ${"A".repeat(68)}`,
  );

  const signersText = await readFile(allowedSignersPath, "utf8");
  const githubCalls: GithubCall[] = [];
  const assets: {
    digest?: string;
    id: number;
    name: string;
    size: number;
    url: string;
  }[] = [
    {
      id: 101,
      name: receipt.dmg.file,
      size: dmgBytes.length,
      url: "https://example.test/dmg",
    },
    {
      id: 102,
      name: receipt.zip.file,
      size: zipBytes.length,
      url: "https://example.test/zip",
    },
  ];
  if (changes.extraAsset) {
    assets.push({
      id: 103,
      name: "extra.bin",
      size: 1,
      url: "https://example.test/extra",
    });
  }
  const release = {
    assets,
    draft: changes.releaseDraft ?? true,
    id: 42,
    tag: "aleph-v0.5.0",
  };
  const github = {
    async getRelease(tag: string) {
      githubCalls.push(`get ${tag}`);
      return structuredClone(release);
    },
    async getReleaseById(id: number) {
      githubCalls.push(`get-id ${id}`);
      return structuredClone(release);
    },
    async setDraft(id: number, draft: boolean) {
      githubCalls.push(`draft ${id} ${draft}`);
    },
    async downloadDraftAsset({
      assetId,
      name,
    }: {
      assetId: number;
      name: string;
    }) {
      githubCalls.push(`download ${assetId} ${name}`);
      if (changes.replaceZipAfterDownload && name.endsWith("zip")) {
        const zipAsset = release.assets.find((asset) => asset.id === 102);
        if (zipAsset) {
          zipAsset.id = 202;
        }
      }
      return name.endsWith("zip") ? (changes.draftZip ?? zipBytes) : dmgBytes;
    },
    async fetchPublicAsset(url: string) {
      githubCalls.push(`fetch ${url}`);
      return url.endsWith("zip") ? (changes.servedZip ?? zipBytes) : dmgBytes;
    },
  };

  return {
    approvalPath,
    expectedSignersSha256: sha256(Buffer.from(signersText)),
    signersPath: allowedSignersPath,
    dmgPath,
    github,
    githubCalls,
    receipt,
    root,
    zipPath,
  };
}

async function publish(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  options: {
    env?: Record<string, string | undefined>;
    now?: Date;
    overrides?: Overrides;
  } = {},
) {
  const { calls, runner } = createRunner(options.overrides ?? {});
  const attempt = publishAlephRelease({
    approvalPath: fixture.approvalPath,
    dmgPath: fixture.dmgPath,
    env: options.env ?? { ALEPH_PUBLISH_APPROVED: "apr-1" },
    github: fixture.github,
    now: options.now ?? new Date("2026-09-30T00:00:00Z"),
    receipt: fixture.receipt,
    runner,
    expectedSignersSha256: fixture.expectedSignersSha256,
    signersPath: fixture.signersPath,
    zipPath: fixture.zipPath,
  });
  return { attempt, calls };
}

async function pinnedDigest(
  fixture: Awaited<ReturnType<typeof createFixture>>,
): Promise<string> {
  return sha256(await readFile(fixture.signersPath));
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("publishAlephRelease", () => {
  it("un-drafts a verified release and checks the public assets anonymously", async () => {
    const fixture = await createFixture();
    const { attempt, calls } = await publish(fixture);
    await attempt;

    expect(calls.some((call) => call.startsWith("ssh-keygen -Y verify"))).toBe(
      true,
    );
    expect(calls.join("\n")).toContain("-n aleph-approval");
    expect(fixture.githubCalls).toEqual([
      "get aleph-v0.5.0",
      "download 101 Aleph-0.5.0-arm64.dmg",
      "download 102 Aleph-0.5.0-arm64.zip",
      "get-id 42",
      "draft 42 false",
      "get-id 42",
      "fetch https://example.test/dmg",
      "fetch https://example.test/zip",
    ]);
  });

  it("refuses without ALEPH_PUBLISH_APPROVED and touches nothing", async () => {
    const fixture = await createFixture();
    const { attempt, calls } = await publish(fixture, { env: {} });

    await expect(attempt).rejects.toThrow("ALEPH_PUBLISH_APPROVED");
    expect(calls).toEqual([]);
    expect(fixture.githubCalls).toEqual([]);
  });

  it("refuses when the approval id differs from the environment value", async () => {
    const fixture = await createFixture();
    const { attempt } = await publish(fixture, {
      env: { ALEPH_PUBLISH_APPROVED: "apr-2" },
    });

    await expect(attempt).rejects.toThrow("approval");
    expect(fixture.githubCalls).toEqual([]);
  });

  it("refuses an approval whose signature does not verify", async () => {
    const fixture = await createFixture();
    const { attempt } = await publish(fixture, {
      overrides: { "ssh-keygen -Y verify": fail("Could not verify signature") },
    });

    await expect(attempt).rejects.toThrow("signature");
    expect(fixture.githubCalls).toEqual([]);
  });

  it("refuses an expired approval batch", async () => {
    const fixture = await createFixture();
    const { attempt } = await publish(fixture, {
      now: new Date("2026-10-01T00:00:01Z"),
    });

    await expect(attempt).rejects.toThrow("batch_valid_until");
    expect(fixture.githubCalls).toEqual([]);
  });

  it.each([
    ["version", { version: "0.6.0" }],
    ["tag", { tag: "aleph-v0.6.0" }],
    ["source_sha", { source_sha: "0".repeat(40) }],
    ["signed_receipt_id", { signed_receipt_id: "d".repeat(64) }],
    ["dmg_sha256", { dmg_sha256: "e".repeat(64) }],
    ["zip_sha256", { zip_sha256: "e".repeat(64) }],
  ])("refuses when the approval %s does not match", async (field, approval) => {
    const fixture = await createFixture({ approval });
    const { attempt } = await publish(fixture);

    await expect(attempt).rejects.toThrow(field);
    expect(fixture.githubCalls).toEqual([]);
  });

  it("refuses when local files were changed after approval", async () => {
    const fixture = await createFixture();
    await writeFile(fixture.zipPath, "tampered");
    const { attempt } = await publish(fixture);

    await expect(attempt).rejects.toThrow("zip");
    expect(fixture.githubCalls).toEqual([]);
  });

  it("refuses a receipt from another team or with a non-Accepted verdict", async () => {
    const wrongTeam = await createFixture({
      receipt: { team_id: "Z45MLNQK64" },
    });
    await expect((await publish(wrongTeam)).attempt).rejects.toThrow("team");

    const rejected = await createFixture({
      receipt: {
        notary: [{ status: "Invalid", submission_id: "s1", target: "app" }],
      },
    });
    await expect((await publish(rejected)).attempt).rejects.toThrow("Accepted");
  });

  it("refuses a receipt whose id does not match its contents", async () => {
    const fixture = await createFixture();
    fixture.receipt.receipt_id = "f".repeat(64);
    const { attempt } = await publish(fixture);

    await expect(attempt).rejects.toThrow("receipt_id");
  });

  it("refuses a release that is not currently a draft", async () => {
    const fixture = await createFixture({ releaseDraft: false });
    const { attempt } = await publish(fixture);

    await expect(attempt).rejects.toThrow("draft");
    expect(fixture.githubCalls).toEqual(["get aleph-v0.5.0"]);
  });

  it("re-drafts and fails when public bytes differ from the approved digest", async () => {
    const fixture = await createFixture({
      servedZip: Buffer.from("different"),
    });
    const { attempt } = await publish(fixture);

    await expect(attempt).rejects.toThrow("re-drafted");
    expect(fixture.githubCalls).toContain("draft 42 true");
    expect(fixture.githubCalls.at(-1)).toBe("draft 42 true");
  });

  it("verifies draft bytes before publishing and never un-drafts on mismatch", async () => {
    const fixture = await createFixture({ draftZip: Buffer.from("swapped") });
    const { attempt } = await publish(fixture);

    await expect(attempt).rejects.toThrow("nothing was published");
    expect(fixture.githubCalls).not.toContain("draft 42 false");
    expect(fixture.githubCalls.some((call) => call.startsWith("fetch"))).toBe(
      false,
    );
  });

  it("refuses to publish a draft holding an asset the approval does not cover", async () => {
    const fixture = await createFixture();
    const original = fixture.github.getRelease;
    fixture.github.getRelease = async (tag: string) => {
      const release = await original(tag);
      release.assets.push({
        id: 103,
        name: "extra.bin",
        size: 1,
        url: "https://example.test/extra",
      });
      return release;
    };
    const { attempt } = await publish(fixture);

    await expect(attempt).rejects.toThrow("extra.bin");
    expect(fixture.githubCalls).not.toContain("draft 42 false");
  });

  it("reports the exposed assets loudly when the re-draft fails", async () => {
    const fixture = await createFixture({
      servedZip: Buffer.from("different"),
    });
    fixture.github.setDraft = async (id: number, draft: boolean) => {
      fixture.githubCalls.push(`draft ${id} ${draft}`);
      if (draft) {
        throw new Error("API down");
      }
    };
    const { attempt } = await publish(fixture);

    await expect(attempt).rejects.toThrow(
      /STILL PUBLIC.*Aleph-0\.5\.0-arm64\.zip/u,
    );
  });

  it("re-drafts when the public fetch fails", async () => {
    const fixture = await createFixture();
    fixture.github.fetchPublicAsset = async () => {
      throw new Error("404");
    };
    const { attempt } = await publish(fixture);

    await expect(attempt).rejects.toThrow("re-drafted");
    expect(fixture.githubCalls.at(-1)).toBe("draft 42 true");
  });

  it("re-drafts when publishing itself throws", async () => {
    const fixture = await createFixture();
    fixture.github.setDraft = async (id: number, draft: boolean) => {
      fixture.githubCalls.push(`draft ${id} ${draft}`);
      if (!draft) {
        throw new Error("network");
      }
    };
    const { attempt } = await publish(fixture);

    await expect(attempt).rejects.toThrow("re-drafted");
    expect(fixture.githubCalls.at(-1)).toBe("draft 42 true");
  });
});

describe("pinned approval key", () => {
  it("refuses to run while the in-repo signers file holds the placeholder", async () => {
    const fixture = await createFixture();
    const { calls, runner } = createRunner();

    await expect(
      publishAlephRelease({
        approvalPath: fixture.approvalPath,
        dmgPath: fixture.dmgPath,
        env: { ALEPH_PUBLISH_APPROVED: "apr-1" },
        github: fixture.github,
        now: new Date("2026-09-30T00:00:00Z"),
        expectedSignersSha256: sha256(
          await readFile(
            join(__dirname, "..", "aleph-approval-allowed-signers"),
          ),
        ),
        receipt: fixture.receipt,
        runner,
        zipPath: fixture.zipPath,
      }),
    ).rejects.toThrow("placeholder");
    expect(calls).toEqual([]);
    expect(fixture.githubCalls).toEqual([]);
  });

  it("rejects an approval self-signed with a caller-controlled key", async () => {
    const fixture = await createFixture();
    const runner = createCommandRunner({ PATH: process.env.PATH });
    const pinnedKey = join(fixture.root, "pinned");
    const callerKey = join(fixture.root, "caller");
    for (const key of [pinnedKey, callerKey]) {
      const generated = await runner("ssh-keygen", [
        "-q",
        "-t",
        "ed25519",
        "-N",
        "",
        "-f",
        key,
      ]);
      expect(generated.exitCode).toBe(0);
    }
    const pinnedPublic = (await readFile(`${pinnedKey}.pub`, "utf8"))
      .trim()
      .split(" ");
    await writeFile(
      fixture.signersPath,
      `aleph-approver namespaces="aleph-approval" ${pinnedPublic[0]} ${pinnedPublic[1]}\n`,
    );
    await rm(`${fixture.approvalPath}.sig`);
    const signed = await runner("ssh-keygen", [
      "-Y",
      "sign",
      "-f",
      callerKey,
      "-n",
      "aleph-approval",
      fixture.approvalPath,
    ]);
    expect(signed.exitCode).toBe(0);
    expect(await readFile(`${fixture.approvalPath}.sig`, "utf8")).toContain(
      "BEGIN SSH SIGNATURE",
    );

    await expect(
      publishAlephRelease({
        approvalPath: fixture.approvalPath,
        dmgPath: fixture.dmgPath,
        env: { ALEPH_PUBLISH_APPROVED: "apr-1" },
        github: fixture.github,
        now: new Date("2026-09-30T00:00:00Z"),
        receipt: fixture.receipt,
        runner,
        expectedSignersSha256: await pinnedDigest(fixture),
        signersPath: fixture.signersPath,
        zipPath: fixture.zipPath,
      }),
    ).rejects.toThrow("signature");
    expect(fixture.githubCalls).toEqual([]);
  });

  it("accepts an approval signed by the pinned key", async () => {
    const fixture = await createFixture();
    const runner = createCommandRunner({ PATH: process.env.PATH });
    const key = join(fixture.root, "pinned");
    await runner("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key]);
    const publicKey = (await readFile(`${key}.pub`, "utf8")).trim().split(" ");
    await writeFile(
      fixture.signersPath,
      `aleph-approver namespaces="aleph-approval" ${publicKey[0]} ${publicKey[1]}\n`,
    );
    await rm(`${fixture.approvalPath}.sig`);
    const signed = await runner("ssh-keygen", [
      "-Y",
      "sign",
      "-f",
      key,
      "-n",
      "aleph-approval",
      fixture.approvalPath,
    ]);
    expect(signed.exitCode).toBe(0);

    await publishAlephRelease({
      approvalPath: fixture.approvalPath,
      dmgPath: fixture.dmgPath,
      env: { ALEPH_PUBLISH_APPROVED: "apr-1" },
      github: fixture.github,
      now: new Date("2026-09-30T00:00:00Z"),
      receipt: fixture.receipt,
      runner,
      expectedSignersSha256: await pinnedDigest(fixture),
      signersPath: fixture.signersPath,
      zipPath: fixture.zipPath,
    });

    expect(fixture.githubCalls).toContain("draft 42 false");
  });

  it("refuses an asset replaced between verification and un-draft", async () => {
    const fixture = await createFixture({ replaceZipAfterDownload: true });
    const { attempt } = await publish(fixture);

    await expect(attempt).rejects.toThrow("changed between verification");
    expect(fixture.githubCalls).not.toContain("draft 42 false");
  });

  it("refuses an asset added between verification and un-draft", async () => {
    const fixture = await createFixture();
    const original = fixture.github.getReleaseById;
    fixture.github.getReleaseById = async (id: number) => {
      const release = await original(id);
      release.assets.push({
        id: 999,
        name: "late.bin",
        size: 1,
        url: "https://example.test/late",
      });
      return release;
    };
    const { attempt } = await publish(fixture);

    await expect(attempt).rejects.toThrow("changed between verification");
    expect(fixture.githubCalls).not.toContain("draft 42 false");
  });

  it("refuses a draft whose published digest disagrees with the approval", async () => {
    const fixture = await createFixture();
    const original = fixture.github.getRelease;
    fixture.github.getRelease = async (tag: string) => {
      const release = await original(tag);
      release.assets[0] = {
        ...release.assets[0],
        digest: `sha256:${"9".repeat(64)}`,
      };
      return release;
    };
    const { attempt } = await publish(fixture);

    await expect(attempt).rejects.toThrow("nothing was published");
    expect(fixture.githubCalls).not.toContain("draft 42 false");
  });

  it("refuses without the expected signers digest and touches nothing", async () => {
    const fixture = await createFixture();
    fixture.expectedSignersSha256 = "";
    const { attempt, calls } = await publish(fixture);

    await expect(attempt).rejects.toThrow("ALEPH_APPROVAL_SIGNERS_SHA256");
    expect(calls).toEqual([]);
    expect(fixture.githubCalls).toEqual([]);
  });

  it("refuses a swapped signers file even when it holds another valid key", async () => {
    const fixture = await createFixture();
    await writeFile(
      fixture.signersPath,
      `aleph-approver namespaces="aleph-approval" ssh-ed25519 ${"B".repeat(68)}\n`,
    );
    const { attempt, calls } = await publish(fixture);

    await expect(attempt).rejects.toThrow("pinned approval signers digest");
    expect(calls).toEqual([]);
    expect(fixture.githubCalls).toEqual([]);
  });

  it("refuses an unpublishable-named artifact", async () => {
    const fixture = await createFixture();
    const unpublishable = join(fixture.root, "Aleph-UNPUBLISHABLE-0.5.0.dmg");
    await writeFile(unpublishable, dmgBytes);
    fixture.dmgPath = unpublishable;
    const { attempt } = await publish(fixture);

    await expect(attempt).rejects.toThrow("UNPUBLISHABLE");
    expect(fixture.githubCalls).toEqual([]);
  });

  it("refuses when the release id moved to another tag before un-draft", async () => {
    const fixture = await createFixture();
    const original = fixture.github.getReleaseById;
    fixture.github.getReleaseById = async (id: number) => ({
      ...(await original(id)),
      tag: "aleph-v9.9.9",
    });
    const { attempt } = await publish(fixture);

    await expect(attempt).rejects.toThrow("changed between verification");
    expect(fixture.githubCalls).not.toContain("draft 42 false");
  });

  it("refuses when the first lookup returns a release under another tag", async () => {
    const fixture = await createFixture();
    const original = fixture.github.getRelease;
    fixture.github.getRelease = async (tag: string) => ({
      ...(await original(tag)),
      tag: "aleph-v9.9.9",
    });
    const { attempt } = await publish(fixture);

    await expect(attempt).rejects.toThrow("not the approved aleph-v0.5.0");
    expect(fixture.githubCalls).not.toContain("draft 42 false");
  });

  it("re-drafts when the post-check finds the release under another tag", async () => {
    const fixture = await createFixture();
    const original = fixture.github.getReleaseById;
    let fetches = 0;
    fixture.github.getReleaseById = async (id: number) => {
      fetches += 1;
      const release = await original(id);
      return fetches === 1 ? release : { ...release, tag: "aleph-v9.9.9" };
    };
    const { attempt } = await publish(fixture);

    await expect(attempt).rejects.toThrow("re-drafted");
    await expect(attempt).rejects.toThrow("not the approved aleph-v0.5.0");
    expect(fixture.githubCalls.at(-1)).toBe("draft 42 true");
  });
});
