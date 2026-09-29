import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ALEPH_APP_NAME,
  ALEPH_BUNDLE_ID,
  ALEPH_SIGNING_IDENTITY,
  ALEPH_TEAM_ID,
  FORBIDDEN_TEAM_IDS,
  createSigningRunnerEnvironment,
} from "./aleph-release-policy.mjs";

const unpublishableMarker = "AlephUnpublishable";
const unpublishableNameToken = "UNPUBLISHABLE";

export function unpublishableNameFailure(path) {
  return basename(path).includes(unpublishableNameToken)
    ? [
        `${path} is named as an unpublishable build (${unpublishableNameToken}); it must never be signed or published.`,
      ]
    : [];
}

async function readIfPresent(path) {
  try {
    return await readFile(path);
  } catch {
    return undefined;
  }
}

export async function findUnpublishableMarker(appPath) {
  const failures = unpublishableNameFailure(appPath);
  const resources = join(appPath, "Contents", "Resources");
  const infoPlist = await readIfPresent(
    join(appPath, "Contents", "Info.plist"),
  );
  if (
    infoPlist !== undefined &&
    new RegExp(`<key>${unpublishableMarker}</key>\\s*<true\\s*/>`, "u").test(
      infoPlist.toString("utf8"),
    )
  ) {
    failures.push(
      `Info.plist of ${appPath} carries ${unpublishableMarker}=true.`,
    );
  }
  for (const candidate of [
    join(resources, "app", "package.json"),
    join(resources, "app.asar"),
  ]) {
    const contents = await readIfPresent(candidate);
    if (contents?.includes(`"${unpublishableMarker}"`)) {
      failures.push(
        `the app package metadata of ${appPath} carries ${unpublishableMarker}.`,
      );
    }
  }
  return failures;
}

export function createCommandRunner(env = process.env) {
  return function run(command, args, options = {}) {
    return new Promise((resolveResult) => {
      const child = spawn(command, args, {
        env: createSigningRunnerEnvironment(env),
        stdio: ["pipe", "pipe", "pipe"],
      });
      const stdout = [];
      const stderr = [];
      child.stdout.on("data", (chunk) => stdout.push(chunk));
      child.stderr.on("data", (chunk) => stderr.push(chunk));
      child.on("error", (error) => {
        resolveResult({
          exitCode: 127,
          stderr: String(error.message),
          stdout: "",
        });
      });
      child.on("close", (code) => {
        resolveResult({
          exitCode: typeof code === "number" ? code : 1,
          stderr: Buffer.concat(stderr).toString("utf8"),
          stdout: Buffer.concat(stdout).toString("utf8"),
        });
      });
      child.stdin.on("error", () => {});
      child.stdin.end(options.input ?? "");
    });
  };
}

export function readEntitlementKeys(plistText) {
  return [...plistText.matchAll(/<key>([^<]+)<\/key>/gu)]
    .map((match) => match[1])
    .sort();
}

function readSignatureField(text, field) {
  const match = new RegExp(`^${field}=(.*)$`, "mu").exec(text);
  return match === null ? undefined : match[1].trim();
}

function describeFailure(result) {
  return (result.stderr || result.stdout).trim().split("\n")[0] ?? "";
}

async function verifySignatureIdentity({
  path,
  requireHardenedRuntime,
  requiredIdentifier,
  runner,
}) {
  const failures = [];
  const result = await runner("codesign", ["-dv", "--verbose=4", path]);
  if (result.exitCode !== 0) {
    failures.push(
      `${path} is unsigned or unreadable: ${describeFailure(result)}`,
    );
    return { failures, teamIdentifier: undefined };
  }

  const text = `${result.stderr}\n${result.stdout}`;
  const teamIdentifier = readSignatureField(text, "TeamIdentifier");
  const authorities = [...text.matchAll(/^Authority=(.*)$/gmu)].map((match) =>
    match[1].trim(),
  );

  if (readSignatureField(text, "Signature") === "adhoc") {
    failures.push(`${path} is ad-hoc signed`);
  }
  if (teamIdentifier !== ALEPH_TEAM_ID) {
    failures.push(
      `${path} TeamIdentifier is ${teamIdentifier ?? "missing"}, expected ${ALEPH_TEAM_ID}`,
    );
  }
  if (FORBIDDEN_TEAM_IDS.includes(teamIdentifier ?? "")) {
    failures.push(`${path} is signed by forbidden team ${teamIdentifier}`);
  }
  if (!authorities.includes(ALEPH_SIGNING_IDENTITY)) {
    failures.push(
      `${path} lacks the expected Developer ID Application authority "${ALEPH_SIGNING_IDENTITY}"`,
    );
  }
  if (requiredIdentifier !== undefined) {
    const identifier = readSignatureField(text, "Identifier");
    if (identifier !== requiredIdentifier) {
      failures.push(
        `${path} Identifier is ${identifier ?? "missing"}, expected ${requiredIdentifier}`,
      );
    }
  }
  if (
    requireHardenedRuntime &&
    !/flags=0x[0-9a-f]+\([^)]*runtime/u.test(text)
  ) {
    failures.push(`${path} does not have the hardened runtime flag`);
  }

  return { failures, teamIdentifier };
}

async function verifyNotarization({ path, gatekeeperArgs, runner }) {
  const failures = [];
  const gatekeeper = await runner("spctl", [...gatekeeperArgs, path]);
  const gatekeeperText = `${gatekeeper.stderr}\n${gatekeeper.stdout}`;
  if (gatekeeper.exitCode !== 0) {
    failures.push(`spctl rejected ${path}: ${describeFailure(gatekeeper)}`);
  } else if (!gatekeeperText.includes("source=Notarized Developer ID")) {
    failures.push(`${path} is not accepted with source=Notarized Developer ID`);
  }

  const stapled = await runner("xcrun", ["stapler", "validate", path]);
  if (stapled.exitCode !== 0) {
    failures.push(
      `${path} has no valid stapled notarization ticket: ${describeFailure(stapled)}`,
    );
  }

  return failures;
}

export async function verifyAlephApp({
  appPath,
  expectedEntitlementKeys,
  runner,
}) {
  const failures = await findUnpublishableMarker(appPath);

  const strict = await runner("codesign", [
    "--verify",
    "--deep",
    "--strict",
    "--verbose=2",
    appPath,
  ]);
  if (strict.exitCode !== 0) {
    failures.push(
      `codesign --verify --deep --strict failed for ${appPath}: ${describeFailure(strict)}`,
    );
  }

  const identity = await verifySignatureIdentity({
    path: appPath,
    requireHardenedRuntime: true,
    requiredIdentifier: ALEPH_BUNDLE_ID,
    runner,
  });
  failures.push(...identity.failures);

  const entitlements = await runner("codesign", [
    "-d",
    "--entitlements",
    "-",
    "--xml",
    appPath,
  ]);
  if (entitlements.exitCode !== 0) {
    failures.push(
      `entitlements of ${appPath} are unreadable: ${describeFailure(entitlements)}`,
    );
  } else {
    const actual = readEntitlementKeys(entitlements.stdout);
    const expected = [...expectedEntitlementKeys].sort();
    const unexpected = actual.filter((key) => !expected.includes(key));
    const missing = expected.filter((key) => !actual.includes(key));
    if (unexpected.length > 0) {
      failures.push(`unexpected entitlements: ${unexpected.join(", ")}`);
    }
    if (missing.length > 0) {
      failures.push(`missing entitlements: ${missing.join(", ")}`);
    }
  }

  failures.push(
    ...(await verifyNotarization({
      gatekeeperArgs: ["-a", "-t", "exec", "-vv"],
      path: appPath,
      runner,
    })),
  );

  return { failures, teamIdentifier: identity.teamIdentifier };
}

export async function verifyAlephDmg({ dmgPath, runner }) {
  const failures = unpublishableNameFailure(dmgPath);
  const strict = await runner("codesign", ["--verify", "--strict", dmgPath]);
  if (strict.exitCode !== 0) {
    failures.push(
      `codesign --verify failed for ${dmgPath}: ${describeFailure(strict)}`,
    );
  }

  const identity = await verifySignatureIdentity({
    path: dmgPath,
    requireHardenedRuntime: false,
    requiredIdentifier: undefined,
    runner,
  });
  failures.push(...identity.failures);
  failures.push(
    ...(await verifyNotarization({
      gatekeeperArgs: [
        "-a",
        "-t",
        "open",
        "--context",
        "context:primary-signature",
        "-vv",
      ],
      path: dmgPath,
      runner,
    })),
  );

  return { failures, teamIdentifier: identity.teamIdentifier };
}

export async function verifyAlephZip({
  expectedEntitlementKeys,
  extractDirectory,
  runner,
  zipPath,
}) {
  const nameFailures = unpublishableNameFailure(zipPath);
  const extracted = await runner("ditto", [
    "-x",
    "-k",
    zipPath,
    extractDirectory,
  ]);
  if (extracted.exitCode !== 0) {
    return {
      failures: [`could not extract ${zipPath}: ${describeFailure(extracted)}`],
      teamIdentifier: undefined,
    };
  }

  const app = await verifyAlephApp({
    appPath: `${extractDirectory}/${ALEPH_APP_NAME}.app`,
    expectedEntitlementKeys,
    runner,
  });
  return { ...app, failures: [...nameFailures, ...app.failures] };
}

function readFlag(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

async function main() {
  const args = process.argv.slice(2);
  const appPath = readFlag(args, "--app");
  const dmgPath = readFlag(args, "--dmg");
  const zipPath = readFlag(args, "--zip");
  const entitlementsPath = resolve(
    fileURLToPath(new URL("../build/entitlements.mac.plist", import.meta.url)),
  );
  if (appPath === undefined || dmgPath === undefined || zipPath === undefined) {
    throw new Error(
      "Usage: verify-aleph-release.mjs --app <Aleph.app> --dmg <Aleph.dmg> --zip <Aleph.zip>",
    );
  }

  const expectedEntitlementKeys = readEntitlementKeys(
    await readFile(entitlementsPath, "utf8"),
  );
  const runner = createCommandRunner();
  const extractDirectory = await mkdtemp(join(tmpdir(), "aleph-verify-zip-"));
  try {
    const results = [
      await verifyAlephApp({ appPath, expectedEntitlementKeys, runner }),
      await verifyAlephDmg({ dmgPath, runner }),
      await verifyAlephZip({
        expectedEntitlementKeys,
        extractDirectory,
        runner,
        zipPath,
      }),
    ];
    const failures = results.flatMap((result) => result.failures);
    if (failures.length > 0) {
      throw new Error(
        `Aleph release verification failed:\n${failures.join("\n")}`,
      );
    }
    console.log("Aleph release verification passed.");
  } finally {
    await rm(extractDirectory, { force: true, recursive: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
