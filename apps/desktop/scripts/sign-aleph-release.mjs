import { existsSync, realpathSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonicalJson,
  digestFile,
  digestTree,
} from "./aleph-build-receipt.mjs";
import {
  ALEPH_APP_NAME,
  ALEPH_BUNDLE_ID,
  ALEPH_NOTARY_KEYCHAIN_PROFILE,
  ALEPH_SIGNING_IDENTITY,
  ALEPH_TEAM_ID,
  createSigningRunnerEnvironment,
} from "./aleph-release-policy.mjs";
import {
  createCommandRunner,
  findUnpublishableMarker,
  readEntitlementKeys,
  verifyAlephApp,
  verifyAlephDmg,
  verifyAlephZip,
} from "./verify-aleph-release.mjs";

const machOMagic = new Set([
  "feedface",
  "feedfacf",
  "cefaedfe",
  "cffaedfe",
  "cafebabe",
  "bebafeca",
]);
const moduleSetDigestEnv = "ALEPH_SIGNER_MODULE_SET_SHA256";
const signerModuleNames = [
  "aleph-build-receipt.mjs",
  "aleph-release-policy.mjs",
  "sign-aleph-release.mjs",
  "verify-aleph-release.mjs",
];
const appBundleName = `${ALEPH_APP_NAME}.app`;
const bundleSuffixes = [".app", ".framework", ".xpc", ".appex", ".bundle"];

async function isMachO(path) {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(4);
    const { bytesRead } = await handle.read(buffer, 0, 4, 0);
    return bytesRead === 4 && machOMagic.has(buffer.toString("hex"));
  } finally {
    await handle.close();
  }
}

async function inventorySignables(root) {
  const found = [];
  async function walk(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        continue;
      }
      if (entry.isDirectory()) {
        await walk(path);
        if (bundleSuffixes.some((suffix) => entry.name.endsWith(suffix))) {
          found.push(path);
        }
      } else if (entry.isFile() && (await isMachO(path))) {
        found.push(path);
      }
    }
  }
  await walk(root);
  const depth = (path) => path.split("/").length;
  return found.sort((a, b) => depth(b) - depth(a) || a.localeCompare(b));
}

async function run(runner, label, command, args) {
  const result = await runner(command, args);
  if (result.exitCode !== 0) {
    throw new Error(
      `${label} failed: ${(result.stderr || result.stdout).trim()}`,
    );
  }
  return result;
}

function codesignArguments({ entitlementsPath, hardened, keychainPath, path }) {
  return [
    "--force",
    "--timestamp",
    ...(hardened ? ["--options", "runtime"] : []),
    "--sign",
    ALEPH_SIGNING_IDENTITY,
    ...(keychainPath ? ["--keychain", keychainPath] : []),
    ...(entitlementsPath ? ["--entitlements", entitlementsPath] : []),
    path,
  ];
}

async function notarize({ keychainPath, path, runner, target }) {
  const result = await runner("xcrun", [
    "notarytool",
    "submit",
    path,
    "--keychain-profile",
    ALEPH_NOTARY_KEYCHAIN_PROFILE,
    ...(keychainPath ? ["--keychain", keychainPath] : []),
    "--wait",
    "--output-format",
    "json",
  ]);
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    parsed = undefined;
  }
  if (
    result.exitCode !== 0 ||
    typeof parsed?.status !== "string" ||
    typeof parsed?.id !== "string"
  ) {
    throw new Error(
      `notarytool submit for the ${target} failed: ${(result.stderr || result.stdout).trim()}`,
    );
  }
  if (parsed.status !== "Accepted") {
    throw new Error(
      `notarytool verdict for the ${target} is ${parsed.status}, not Accepted (submission ${parsed.id})`,
    );
  }
  return { status: parsed.status, submission_id: parsed.id, target };
}

async function fileRecord(path) {
  return {
    file: basename(path),
    sha256: await digestFile(path),
    size: (await stat(path)).size,
  };
}

function canonicalPath(path) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function isInside(path, directory) {
  return path === directory || path.startsWith(`${directory}${sep}`);
}

function findCheckoutRoot(path) {
  let directory = dirname(path);
  while (directory !== dirname(directory)) {
    if (existsSync(join(directory, ".git"))) {
      return directory;
    }
    directory = dirname(directory);
  }
  return undefined;
}

function assertSignerIsNotCandidate({ appPath, signerPath }) {
  const app = canonicalPath(appPath);
  const signer = canonicalPath(signerPath);
  const checkoutRoot = findCheckoutRoot(signer);
  if (isInside(signer, app) || (checkoutRoot && isInside(app, checkoutRoot))) {
    throw new Error(
      `Refusing to sign: the signer ${signer} runs from the candidate tree. Run the digest-pinned recipe from a separate checkout and pass the candidate only as data.`,
    );
  }
}

export async function computeSignerModuleSetDigest(
  directory = dirname(fileURLToPath(import.meta.url)),
) {
  const digests = {};
  for (const name of signerModuleNames) {
    digests[name] = await digestFile(join(directory, name));
  }
  return createHash("sha256").update(canonicalJson(digests)).digest("hex");
}

async function assertSignerIsPinnedRecipe({
  expectedModuleSetSha256,
  signerDirectory,
}) {
  if (!/^[0-9a-f]{64}$/u.test(expectedModuleSetSha256 ?? "")) {
    throw new Error(
      `Refusing to sign: the expected sha256 of the signer module set (${moduleSetDigestEnv}) is missing. The digest-pinned ops recipe must supply it.`,
    );
  }
  if (
    (await computeSignerModuleSetDigest(signerDirectory)) !==
    expectedModuleSetSha256
  ) {
    throw new Error(
      "Refusing to sign: the signer modules do not match the pinned module-set digest.",
    );
  }
}

function assertBuildReceiptBindsApp(buildReceipt) {
  if (
    buildReceipt?.schema !== "aleph-build-receipt/1" ||
    !/^[0-9a-f]{64}$/u.test(buildReceipt.artifact_digest ?? "") ||
    !/^[0-9a-f]{40}$/u.test(buildReceipt.source_sha ?? "") ||
    typeof buildReceipt.version !== "string" ||
    buildReceipt.version.length === 0
  ) {
    throw new Error(
      "Refusing to sign: the BuildReceipt does not bind an artifact digest, source SHA and version.",
    );
  }
}

export async function signAlephRelease(options) {
  const receiptPath = join(
    options.outputDirectory,
    "SignedArtifactReceipt.json",
  );
  await rm(receiptPath, { force: true });
  try {
    const signerDirectory =
      options.signerDirectory ?? dirname(fileURLToPath(import.meta.url));
    assertSignerIsNotCandidate({
      appPath: options.appPath,
      signerPath:
        options.signerPath ?? join(signerDirectory, "sign-aleph-release.mjs"),
    });
    await assertSignerIsPinnedRecipe({
      expectedModuleSetSha256: options.expectedModuleSetSha256,
      signerDirectory,
    });
    assertBuildReceiptBindsApp(options.buildReceipt);
    return await signVerifiedCandidate(options);
  } catch (error) {
    await rm(receiptPath, { force: true });
    throw error;
  }
}

async function signVerifiedCandidate({
  appPath,
  buildReceipt,
  entitlementsPath,
  inheritEntitlementsPath,
  keychainPath,
  outputDirectory,
  runner,
}) {
  if (basename(appPath) !== appBundleName) {
    throw new Error(`Refusing to sign ${appPath}: expected ${appBundleName}.`);
  }
  if ((await digestTree(appPath)) !== buildReceipt.artifact_digest) {
    throw new Error(
      "The app does not match the BuildReceipt artifact digest; refusing to sign.",
    );
  }

  const unpublishable = await findUnpublishableMarker(appPath);
  if (unpublishable.length > 0) {
    throw new Error(`Refusing to sign: ${unpublishable.join(" ")}`);
  }

  const version = buildReceipt.version;
  const nested = await inventorySignables(appPath);
  for (const path of nested) {
    await run(
      runner,
      `codesign ${path}`,
      "codesign",
      codesignArguments({
        entitlementsPath: inheritEntitlementsPath,
        hardened: true,
        keychainPath,
        path,
      }),
    );
  }
  await run(
    runner,
    `codesign ${appPath}`,
    "codesign",
    codesignArguments({
      entitlementsPath,
      hardened: true,
      keychainPath,
      path: appPath,
    }),
  );
  await run(runner, "codesign verification", "codesign", [
    "--verify",
    "--deep",
    "--strict",
    "--verbose=2",
    appPath,
  ]);

  await mkdir(outputDirectory, { recursive: true });
  const workDirectory = await mkdtemp(join(tmpdir(), "aleph-sign-work-"));
  try {
    const notaryZip = join(workDirectory, "notarize-app.zip");
    await run(runner, "ditto (notarization archive)", "ditto", [
      "-c",
      "-k",
      "--keepParent",
      appPath,
      notaryZip,
    ]);
    const notary = [
      await notarize({ keychainPath, path: notaryZip, runner, target: "app" }),
    ];
    await run(runner, "stapler staple (app)", "xcrun", [
      "stapler",
      "staple",
      appPath,
    ]);

    const dmgPath = join(outputDirectory, `Aleph-${version}-arm64.dmg`);
    const zipPath = join(outputDirectory, `Aleph-${version}-arm64.zip`);
    const staging = join(workDirectory, "dmg-staging");
    await mkdir(staging, { recursive: true });
    await run(runner, "ditto (dmg staging)", "ditto", [
      appPath,
      join(staging, appBundleName),
    ]);
    await symlink("/Applications", join(staging, "Applications"));
    await rm(dmgPath, { force: true });
    await run(runner, "hdiutil create", "hdiutil", [
      "create",
      "-volname",
      "Aleph",
      "-srcfolder",
      staging,
      "-ov",
      "-format",
      "UDZO",
      dmgPath,
    ]);
    await run(
      runner,
      `codesign ${dmgPath}`,
      "codesign",
      codesignArguments({
        hardened: false,
        keychainPath,
        path: dmgPath,
      }),
    );
    notary.push(
      await notarize({ keychainPath, path: dmgPath, runner, target: "dmg" }),
    );
    await run(runner, "stapler staple (dmg)", "xcrun", [
      "stapler",
      "staple",
      dmgPath,
    ]);

    await rm(zipPath, { force: true });
    await run(runner, "ditto (release zip)", "ditto", [
      "-c",
      "-k",
      "--keepParent",
      appPath,
      zipPath,
    ]);

    const entitlementsText = await readFile(entitlementsPath, "utf8");
    const expectedEntitlementKeys = readEntitlementKeys(entitlementsText);
    const extractDirectory = join(workDirectory, "zip-extract");
    await mkdir(extractDirectory, { recursive: true });
    const appResult = await verifyAlephApp({
      appPath,
      expectedEntitlementKeys,
      runner,
    });
    const dmgResult = await verifyAlephDmg({ dmgPath, runner });
    const zipResult = await verifyAlephZip({
      expectedEntitlementKeys,
      extractDirectory,
      runner,
      zipPath,
    });
    const failures = [
      ...appResult.failures,
      ...dmgResult.failures,
      ...zipResult.failures,
    ];
    if (failures.length > 0) {
      throw new Error(`Release verification failed:\n${failures.join("\n")}`);
    }
    if (appResult.teamIdentifier !== ALEPH_TEAM_ID) {
      throw new Error(
        `Release verification failed: TeamIdentifier ${appResult.teamIdentifier} is not ${ALEPH_TEAM_ID}`,
      );
    }

    const receiptBody = {
      build_receipt_digest: createHash("sha256")
        .update(canonicalJson(buildReceipt))
        .digest("hex"),
      bundle_id: ALEPH_BUNDLE_ID,
      dmg: await fileRecord(dmgPath),
      entitlements_sha256: await digestFile(entitlementsPath),
      notary,
      schema: "aleph-signed-artifact-receipt/1",
      source_sha: buildReceipt.source_sha,
      team_id: appResult.teamIdentifier,
      version,
      zip: await fileRecord(zipPath),
    };
    const receiptId = createHash("sha256")
      .update(canonicalJson(receiptBody))
      .digest("hex");
    const receipt = { ...receiptBody, receipt_id: receiptId };
    const receiptPath = join(outputDirectory, "SignedArtifactReceipt.json");
    await writeFile(receiptPath, `${canonicalJson(receipt)}\n`);
    return { receipt, receiptPath };
  } finally {
    await rm(workDirectory, { force: true, recursive: true });
  }
}

function readFlag(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

async function main() {
  const args = process.argv.slice(2);
  const appPath = readFlag(args, "--app");
  const buildReceiptPath = readFlag(args, "--build-receipt");
  const outputDirectory = readFlag(args, "--out");
  if (!appPath || !buildReceiptPath || !outputDirectory) {
    throw new Error(
      "Usage: sign-aleph-release.mjs --app <Aleph.app> --build-receipt <file> --out <dir> [--keychain <path>]",
    );
  }
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const buildReceipt = JSON.parse(await readFile(buildReceiptPath, "utf8"));
  const { receipt, receiptPath } = await signAlephRelease({
    appPath: resolve(appPath),
    buildReceipt,
    entitlementsPath: join(packageRoot, "build", "entitlements.mac.plist"),
    inheritEntitlementsPath: join(
      packageRoot,
      "build",
      "entitlements.mac.inherit.plist",
    ),
    expectedModuleSetSha256: process.env[moduleSetDigestEnv]?.trim(),
    keychainPath: readFlag(args, "--keychain"),
    outputDirectory: resolve(outputDirectory),
    runner: createCommandRunner(createSigningRunnerEnvironment(process.env)),
  });
  console.log(
    `Signed and notarized. Receipt ${receipt.receipt_id} at ${receiptPath}`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
