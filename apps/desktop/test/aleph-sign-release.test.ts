import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createBuildReceipt } from "../scripts/aleph-build-receipt.mjs";
import {
  computeSignerModuleSetDigest,
  signAlephRelease,
} from "../scripts/sign-aleph-release.mjs";
import {
  createRunner,
  fail,
  ok,
  type Overrides,
} from "./helpers/aleph-fake-runner.js";

const machO = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 0, 0, 0]);
const identity =
  "Developer ID Application: General Systems Ventures LLC (W964996768)";
const sourceSha = "3e7e1a3b4750e67f9af1f60efed1900111740413";
const temporaryDirectories: string[] = [];
const realScriptsDirectory = join(__dirname, "..", "scripts");
let pinnedModuleSetSha256 = "";

type Workspace = {
  app: string;
  buildReceipt: Awaited<ReturnType<typeof createBuildReceipt>>;
  entitlements: string;
  inheritEntitlements: string;
  output: string;
  root: string;
};

async function createWorkspace(): Promise<Workspace> {
  const root = await mkdtemp(join(tmpdir(), "aleph-sign-"));
  temporaryDirectories.push(root);
  const app = join(root, "Aleph.app");
  const framework = join(
    app,
    "Contents",
    "Frameworks",
    "Electron Framework.framework",
  );
  const helper = join(app, "Contents", "Frameworks", "Aleph Helper.app");
  await mkdir(join(app, "Contents", "MacOS"), { recursive: true });
  await mkdir(join(app, "Contents", "Resources"), { recursive: true });
  await mkdir(join(framework, "Versions", "A", "Libraries"), {
    recursive: true,
  });
  await mkdir(join(helper, "Contents", "MacOS"), { recursive: true });
  await writeFile(join(app, "Contents", "MacOS", "Aleph"), machO);
  await writeFile(join(app, "Contents", "Resources", "app.asar"), "asar");
  await writeFile(
    join(framework, "Versions", "A", "Electron Framework"),
    machO,
  );
  await writeFile(
    join(framework, "Versions", "A", "Libraries", "libffmpeg.dylib"),
    machO,
  );
  await writeFile(join(helper, "Contents", "MacOS", "Aleph Helper"), machO);
  await symlink(
    "Versions/A/Electron Framework",
    join(framework, "Electron Framework"),
  );
  const entitlements = join(root, "entitlements.plist");
  const inheritEntitlements = join(root, "entitlements.inherit.plist");
  await writeFile(
    entitlements,
    "<plist><dict><key>com.apple.security.cs.allow-jit</key><true/><key>com.apple.security.device.audio-input</key><true/></dict></plist>",
  );
  await writeFile(inheritEntitlements, "<plist><dict/></plist>");
  const lockfile = join(root, "pnpm-lock.yaml");
  await writeFile(lockfile, "lock");
  const buildReceipt = await createBuildReceipt({
    appPath: app,
    lockfilePath: lockfile,
    recipePaths: [],
    repoId: "R_kgDOAbc123",
    sourceSha,
    toolVersions: { node: "24.0.0" },
    version: "0.5.0",
  });

  return {
    app,
    buildReceipt,
    entitlements,
    inheritEntitlements,
    output: join(root, "out"),
    root,
  };
}

function fileWriter(): (command: string, args: string[]) => Promise<void> {
  return async (command, args) => {
    const line = [command, ...args].join(" ");
    if (line.startsWith("ditto -c -k")) {
      await writeFile(args[args.length - 1] ?? "", `zip:${line}`);
    }
    if (line.startsWith("hdiutil create")) {
      await writeFile(args[args.length - 1] ?? "", "dmg");
    }
  };
}

async function sign(
  workspace: Workspace,
  overrides: Overrides = {},
  extra: { keychainPath?: string } = {},
) {
  const { calls, runner } = createRunner(overrides, fileWriter());
  const attempt = signAlephRelease({
    appPath: workspace.app,
    buildReceipt: workspace.buildReceipt,
    entitlementsPath: workspace.entitlements,
    inheritEntitlementsPath: workspace.inheritEntitlements,
    outputDirectory: workspace.output,
    expectedModuleSetSha256: pinnedModuleSetSha256,
    runner,
    ...extra,
  });
  return { attempt, calls };
}

beforeAll(async () => {
  pinnedModuleSetSha256 = await computeSignerModuleSetDigest();
});

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("signAlephRelease", () => {
  it("signs inside-out with the explicit identity and hardened runtime", async () => {
    const workspace = await createWorkspace();
    const { attempt, calls } = await sign(workspace);
    await attempt;

    const signCalls = calls.filter((call) =>
      call.startsWith("codesign --force"),
    );
    const lastAppSign = signCalls
      .map((call, index) => ({ call, index }))
      .filter(({ call }) => call.endsWith(`${workspace.app}`))
      .at(-1);

    expect(signCalls.length).toBeGreaterThanOrEqual(5);
    for (const call of signCalls.filter((entry) => !entry.endsWith(".dmg"))) {
      expect(call).toContain(`--sign ${identity}`);
      expect(call).toContain("--options runtime");
      expect(call).toContain("--timestamp");
      expect(call).not.toContain("--deep");
      expect(call).not.toContain("--sign -");
    }
    expect(lastAppSign?.index).toBe(
      signCalls.filter((call) => !call.endsWith(".dmg")).length - 1,
    );
    const frameworkBinary = signCalls.findIndex((call) =>
      call.endsWith("Versions/A/Electron Framework"),
    );
    const frameworkBundle = signCalls.findIndex((call) =>
      call.endsWith("Electron Framework.framework"),
    );
    expect(frameworkBinary).toBeGreaterThanOrEqual(0);
    expect(frameworkBinary).toBeLessThan(frameworkBundle);
    expect(
      signCalls.findIndex((call) => call.endsWith("libffmpeg.dylib")),
    ).toBeLessThan(frameworkBundle);
  });

  it("uses the main entitlements only for the app and the inherit set for nested code", async () => {
    const workspace = await createWorkspace();
    const { attempt, calls } = await sign(workspace);
    await attempt;

    const appSign = calls.find(
      (call) =>
        call.startsWith("codesign --force") && call.endsWith(workspace.app),
    );
    const helperSign = calls.find(
      (call) =>
        call.startsWith("codesign --force") &&
        call.endsWith("Aleph Helper.app"),
    );

    expect(appSign).toContain(`--entitlements ${workspace.entitlements}`);
    expect(helperSign).toContain(
      `--entitlements ${workspace.inheritEntitlements}`,
    );
  });

  it("does not follow or sign symlinks", async () => {
    const workspace = await createWorkspace();
    const { attempt, calls } = await sign(workspace);
    await attempt;

    expect(
      calls.filter(
        (call) =>
          call.startsWith("codesign --force") &&
          call.endsWith("Electron Framework.framework/Electron Framework"),
      ),
    ).toEqual([]);
  });

  it("notarizes only through the aleph-notary keychain profile", async () => {
    const workspace = await createWorkspace();
    const { attempt, calls } = await sign(
      workspace,
      {},
      {
        keychainPath:
          "/Users/aleph-sign/Library/Keychains/aleph-apple.keychain-db",
      },
    );
    await attempt;

    const submissions = calls.filter((call) =>
      call.includes("notarytool submit"),
    );
    expect(submissions).toHaveLength(2);
    for (const call of submissions) {
      expect(call).toContain("--keychain-profile aleph-notary");
      expect(call).toContain("--wait");
      expect(call).toContain("--output-format json");
      expect(call).toContain(
        "--keychain /Users/aleph-sign/Library/Keychains/aleph-apple.keychain-db",
      );
      expect(call).not.toMatch(/--apple-id|--password|--team-id|--key\b|\.p8/u);
    }
    for (const call of calls) {
      expect(call).not.toMatch(
        /find-(?:generic|internet)-password|dump-keychain|security export|store-credentials/u,
      );
    }
  });

  it("staples the app and the disk image, then builds the ZIP from the stapled app", async () => {
    const workspace = await createWorkspace();
    const { attempt, calls } = await sign(workspace);
    await attempt;

    const stapleApp = calls.findIndex(
      (call) => call === `xcrun stapler staple ${workspace.app}`,
    );
    const zipBuild = calls.findIndex(
      (call) =>
        call.startsWith("ditto -c -k --keepParent") &&
        call.endsWith("Aleph-0.5.0-arm64.zip"),
    );
    const dmgBuild = calls.findIndex((call) =>
      call.startsWith("hdiutil create"),
    );
    const stapleDmg = calls.findIndex(
      (call) =>
        call.startsWith("xcrun stapler staple") && call.endsWith(".dmg"),
    );

    expect(stapleApp).toBeGreaterThan(-1);
    expect(dmgBuild).toBeGreaterThan(stapleApp);
    expect(stapleDmg).toBeGreaterThan(dmgBuild);
    expect(zipBuild).toBeGreaterThan(stapleApp);
  });

  it("writes a receipt with public identifiers, digests and verdicts only", async () => {
    const workspace = await createWorkspace();
    const { attempt } = await sign(workspace);
    const { receipt, receiptPath } = await attempt;

    expect(receipt).toMatchObject({
      bundle_id: "com.generalsystemsventures.aleph",
      notary: [
        { status: "Accepted", target: "app" },
        { status: "Accepted", target: "dmg" },
      ],
      schema: "aleph-signed-artifact-receipt/1",
      source_sha: sourceSha,
      team_id: "W964996768",
      version: "0.5.0",
    });
    expect(receipt.build_receipt_digest).toMatch(/^[0-9a-f]{64}$/u);
    expect(receipt.dmg.sha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(receipt.zip.sha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(receipt.entitlements_sha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(receipt.receipt_id).toMatch(/^[0-9a-f]{64}$/u);
    const onDisk = JSON.parse(await readFile(receiptPath, "utf8"));
    expect(onDisk).toEqual(receipt);
    expect((await stat(receiptPath)).isFile()).toBe(true);
    expect(JSON.stringify(receipt)).not.toMatch(/password|\.p8|BEGIN/u);
  });

  it("fails before signing when the app does not match the build receipt", async () => {
    const workspace = await createWorkspace();
    await writeFile(
      join(workspace.app, "Contents", "MacOS", "Aleph"),
      "swapped",
    );
    const { attempt, calls } = await sign(workspace);

    await expect(attempt).rejects.toThrow("BuildReceipt");
    expect(calls).toEqual([]);
  });

  it("fails closed when the signing identity is missing and does not notarize", async () => {
    const workspace = await createWorkspace();
    const { attempt, calls } = await sign(workspace, {
      "codesign --force": fail(`${identity}: no identity found`),
    });

    await expect(attempt).rejects.toThrow("no identity found");
    expect(calls.some((call) => call.includes("notarytool"))).toBe(false);
  });

  it("fails closed when the notary verdict is not Accepted and staples nothing", async () => {
    const workspace = await createWorkspace();
    const { attempt, calls } = await sign(workspace, {
      "notarytool submit": ok(
        JSON.stringify({ id: "sub-1", status: "Invalid", message: "bad" }),
      ),
    });

    await expect(attempt).rejects.toThrow("Invalid");
    expect(calls.some((call) => call.includes("stapler staple"))).toBe(false);
  });

  it("fails closed when notarytool exits non-zero", async () => {
    const workspace = await createWorkspace();
    const { attempt } = await sign(workspace, {
      "notarytool submit": fail(
        "Error: no Keychain password item found for profile: aleph-notary",
      ),
    });

    await expect(attempt).rejects.toThrow("notarytool");
  });

  it("fails closed on unparsable notary output", async () => {
    const workspace = await createWorkspace();
    const { attempt } = await sign(workspace, {
      "notarytool submit": ok("not json"),
    });

    await expect(attempt).rejects.toThrow("notarytool");
  });

  it("fails closed when stapling fails", async () => {
    const workspace = await createWorkspace();
    const { attempt } = await sign(workspace, {
      "stapler staple": fail("Could not validate ticket"),
    });

    await expect(attempt).rejects.toThrow("staple");
  });

  it("writes no receipt when final verification fails", async () => {
    const workspace = await createWorkspace();
    const { attempt } = await sign(workspace, {
      "spctl -a -t open": ok("", "accepted\nsource=Developer ID"),
    });

    await expect(attempt).rejects.toThrow("Notarized Developer ID");
    await expect(
      stat(join(workspace.output, "SignedArtifactReceipt.json")),
    ).rejects.toThrow();
  });

  it("refuses an app that is not named Aleph.app", async () => {
    const workspace = await createWorkspace();
    const { calls, runner } = createRunner();

    await expect(
      signAlephRelease({
        appPath: join(workspace.root, "bb.app"),
        buildReceipt: workspace.buildReceipt,
        entitlementsPath: workspace.entitlements,
        inheritEntitlementsPath: workspace.inheritEntitlements,
        outputDirectory: workspace.output,
        expectedModuleSetSha256: pinnedModuleSetSha256,
        runner,
      }),
    ).rejects.toThrow("Aleph.app");
    expect(calls).toEqual([]);
  });

  it("removes a stale receipt when the build digest check fails", async () => {
    const workspace = await createWorkspace();
    const receiptPath = join(workspace.output, "SignedArtifactReceipt.json");
    await mkdir(workspace.output, { recursive: true });
    await writeFile(receiptPath, '{"stale":true}');
    await writeFile(
      join(workspace.app, "Contents", "MacOS", "Aleph"),
      "swapped",
    );
    const { attempt } = await sign(workspace);

    await expect(attempt).rejects.toThrow("BuildReceipt");
    await expect(stat(receiptPath)).rejects.toThrow();
  });

  it("removes a stale receipt when a later stage fails", async () => {
    const workspace = await createWorkspace();
    const receiptPath = join(workspace.output, "SignedArtifactReceipt.json");
    await mkdir(workspace.output, { recursive: true });
    await writeFile(receiptPath, '{"stale":true}');
    const { attempt } = await sign(workspace, {
      "notarytool submit": ok(JSON.stringify({ id: "s", status: "Invalid" })),
    });

    await expect(attempt).rejects.toThrow("Invalid");
    await expect(stat(receiptPath)).rejects.toThrow();
  });

  it("refuses to run from inside the candidate app tree and signs nothing", async () => {
    const workspace = await createWorkspace();
    const { calls, runner } = createRunner();

    await expect(
      signAlephRelease({
        appPath: workspace.app,
        buildReceipt: workspace.buildReceipt,
        entitlementsPath: workspace.entitlements,
        inheritEntitlementsPath: workspace.inheritEntitlements,
        outputDirectory: workspace.output,
        expectedModuleSetSha256: pinnedModuleSetSha256,
        runner,
        signerPath: join(workspace.app, "Contents", "Resources", "sign.mjs"),
      }),
    ).rejects.toThrow("candidate");
    expect(calls).toEqual([]);
  });

  it("refuses to run from a checkout that contains the candidate app", async () => {
    const workspace = await createWorkspace();
    await mkdir(join(workspace.root, ".git"));
    await mkdir(join(workspace.root, "apps", "desktop", "scripts"), {
      recursive: true,
    });
    const { calls, runner } = createRunner();

    await expect(
      signAlephRelease({
        appPath: workspace.app,
        buildReceipt: workspace.buildReceipt,
        entitlementsPath: workspace.entitlements,
        inheritEntitlementsPath: workspace.inheritEntitlements,
        outputDirectory: workspace.output,
        expectedModuleSetSha256: pinnedModuleSetSha256,
        runner,
        signerPath: join(
          workspace.root,
          "apps",
          "desktop",
          "scripts",
          "sign.mjs",
        ),
      }),
    ).rejects.toThrow("candidate");
    expect(calls).toEqual([]);
  });

  it("refuses when no module-set digest is supplied and signs nothing", async () => {
    const workspace = await createWorkspace();
    const { calls, runner } = createRunner();

    await expect(
      signAlephRelease({
        appPath: workspace.app,
        buildReceipt: workspace.buildReceipt,
        entitlementsPath: workspace.entitlements,
        inheritEntitlementsPath: workspace.inheritEntitlements,
        expectedModuleSetSha256: undefined,
        outputDirectory: workspace.output,
        runner,
      }),
    ).rejects.toThrow("ALEPH_SIGNER_MODULE_SET_SHA256");
    expect(calls).toEqual([]);
  });

  it("refuses a module-set digest that does not match the running modules", async () => {
    const workspace = await createWorkspace();
    const { calls, runner } = createRunner();

    await expect(
      signAlephRelease({
        appPath: workspace.app,
        buildReceipt: workspace.buildReceipt,
        entitlementsPath: workspace.entitlements,
        inheritEntitlementsPath: workspace.inheritEntitlements,
        expectedModuleSetSha256: "0".repeat(64),
        outputDirectory: workspace.output,
        runner,
      }),
    ).rejects.toThrow("pinned module-set digest");
    expect(calls).toEqual([]);
  });

  it("refuses a candidate-checkout signer signing an app copied elsewhere", async () => {
    const workspace = await createWorkspace();
    const candidate = await mkdtemp(join(tmpdir(), "aleph-candidate-"));
    temporaryDirectories.push(candidate);
    await mkdir(join(candidate, ".git"));
    const candidateScripts = join(candidate, "apps", "desktop", "scripts");
    await cp(realScriptsDirectory, candidateScripts, { recursive: true });
    await writeFile(
      join(candidateScripts, "verify-aleph-release.mjs"),
      "export const tampered = true;\n",
    );
    const { calls, runner } = createRunner();

    await expect(
      signAlephRelease({
        appPath: workspace.app,
        buildReceipt: workspace.buildReceipt,
        entitlementsPath: workspace.entitlements,
        inheritEntitlementsPath: workspace.inheritEntitlements,
        expectedModuleSetSha256: pinnedModuleSetSha256,
        outputDirectory: workspace.output,
        runner,
        signerDirectory: candidateScripts,
      }),
    ).rejects.toThrow("pinned module-set digest");
    expect(calls).toEqual([]);
  });

  it("refuses a BuildReceipt that does not bind the artifact", async () => {
    const workspace = await createWorkspace();
    const { calls, runner } = createRunner();

    await expect(
      signAlephRelease({
        appPath: workspace.app,
        buildReceipt: { ...workspace.buildReceipt, artifact_digest: "" },
        entitlementsPath: workspace.entitlements,
        inheritEntitlementsPath: workspace.inheritEntitlements,
        expectedModuleSetSha256: pinnedModuleSetSha256,
        outputDirectory: workspace.output,
        runner,
      }),
    ).rejects.toThrow("does not bind");
    expect(calls).toEqual([]);
  });

  it("refuses an app carrying the unpublishable marker and signs nothing", async () => {
    const workspace = await createWorkspace();
    await writeFile(
      join(workspace.app, "Contents", "Info.plist"),
      "<plist><dict><key>AlephUnpublishable</key><true/></dict></plist>",
    );
    const buildReceipt = await createBuildReceipt({
      appPath: workspace.app,
      lockfilePath: join(workspace.root, "pnpm-lock.yaml"),
      recipePaths: [],
      repoId: "R_kgDOAbc123",
      sourceSha,
      toolVersions: { node: "24.0.0" },
      version: "0.5.0",
    });
    const { calls, runner } = createRunner();

    await expect(
      signAlephRelease({
        appPath: workspace.app,
        buildReceipt,
        entitlementsPath: workspace.entitlements,
        inheritEntitlementsPath: workspace.inheritEntitlements,
        expectedModuleSetSha256: pinnedModuleSetSha256,
        outputDirectory: workspace.output,
        runner,
      }),
    ).rejects.toThrow("AlephUnpublishable");
    expect(calls).toEqual([]);
  });
});
