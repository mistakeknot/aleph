import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DESKTOP_RELEASE_CHANNEL_ENV_NAME = "BB_DESKTOP_RELEASE_CHANNEL";
const DESKTOP_PACKAGE_JSON_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "package.json",
);

/**
 * Mirrors `isAlephAppVersion` in packages/config/src/app-update.ts. Kept as a
 * separate copy because these build scripts run under plain Node, which
 * cannot resolve that package's TypeScript source without a loader.
 */
function isAlephDesktopVersion(version) {
  const buildStart = version.indexOf("+");
  if (buildStart === -1) {
    return false;
  }
  return version
    .slice(buildStart + 1)
    .split(".")
    .some((identifier) => identifier.split("-").includes("aleph"));
}

function parseAlephRelease(version) {
  const buildStart = version.indexOf("+");
  const build = buildStart === -1 ? "" : version.slice(buildStart + 1);
  const release = /^aleph\.(\d+)\.(\d+)\.(\d+)$/u.exec(build);
  if (release !== null) {
    return release.slice(1).map(Number);
  }
  const legacy = /^aleph\.(\d+)$/u.exec(build);
  if (legacy !== null) {
    return [0, Number(legacy[1]), 0];
  }
  throw new Error(
    `Not an Aleph version: ${version}; expected <upstream version>+aleph.<X.Y.Z>.`,
  );
}

/**
 * CFBundleVersion for an Aleph build: major * 1000000 + minor * 10000 +
 * patch * 100 + rebuild, so 0.5.0 is 50000. Minor, patch and the per-release
 * rebuild counter each stay under 100, which keeps the integer strictly
 * ordered by Aleph release; the upstream base never enters it.
 */
export function alephBundleVersion(version, rebuild = 0) {
  const [major, minor, patch] = parseAlephRelease(version);
  if (minor > 99 || patch > 99) {
    throw new Error(
      `Aleph version ${version} has a minor or patch above 99; CFBundleVersion cannot stay monotonic past 100.`,
    );
  }
  if (!Number.isInteger(rebuild) || rebuild < 0 || rebuild > 99) {
    throw new Error(
      `Aleph rebuild counter must be an integer from 0 to 99, got ${String(rebuild)}.`,
    );
  }
  return String(major * 1_000_000 + minor * 10_000 + patch * 100 + rebuild);
}

export function readDesktopPackageVersion(
  packageJsonPath = DESKTOP_PACKAGE_JSON_PATH,
) {
  return JSON.parse(readFileSync(packageJsonPath, "utf8")).version;
}

export function resolveDesktopReleaseChannel(
  env,
  packageVersion = readDesktopPackageVersion(),
) {
  const alephPackage = isAlephDesktopVersion(packageVersion);
  const rawChannel = env[DESKTOP_RELEASE_CHANNEL_ENV_NAME]?.trim();
  if (rawChannel === undefined || rawChannel.length === 0) {
    return alephPackage ? "aleph" : "latest";
  }
  if (
    rawChannel !== "latest" &&
    rawChannel !== "nightly" &&
    rawChannel !== "aleph"
  ) {
    throw new Error(
      `${DESKTOP_RELEASE_CHANNEL_ENV_NAME} must be latest, nightly, or aleph, got ${rawChannel}.`,
    );
  }
  if (alephPackage && rawChannel !== "aleph") {
    throw new Error(
      `${DESKTOP_RELEASE_CHANNEL_ENV_NAME}=${rawChannel} contradicts the Aleph package version ${packageVersion}; an Aleph package builds only the aleph channel.`,
    );
  }
  return rawChannel;
}

/**
 * The version the packaged app reports (CFBundleShortVersionString, update
 * metadata, the app itself). Aleph ships its plain release, such as 0.5.0, so
 * SemVer orders 0.5.0 before 0.5.1; the upstream base travels separately as
 * AlephUpstreamBase.
 */
export function desktopAppVersion(channel, packageVersion) {
  if (channel !== "aleph") {
    return packageVersion;
  }
  return parseAlephRelease(packageVersion).join(".");
}

export function alephUpstreamBase(packageVersion) {
  parseAlephRelease(packageVersion);
  return packageVersion.slice(0, packageVersion.indexOf("+"));
}

/**
 * The release ledger lists every published Aleph build as
 * { version, rebuild, bundleVersion }. A new build's CFBundleVersion must
 * exceed every ledgered one, which also rejects a rebuild of a ledgered build.
 */
export function assertBundleVersionFollowsLedger(ledger, bundleVersion) {
  const next = BigInt(bundleVersion);
  for (const entry of ledger.releases) {
    if (BigInt(entry.bundleVersion) === next) {
      throw new Error(
        `CFBundleVersion ${bundleVersion} is already ledgered for ${entry.version} rebuild ${entry.rebuild}; raise ALEPH_BUNDLE_REBUILD or the Aleph release.`,
      );
    }
    if (BigInt(entry.bundleVersion) > next) {
      throw new Error(
        `CFBundleVersion ${bundleVersion} is not greater than ledgered ${entry.bundleVersion} (${entry.version} rebuild ${entry.rebuild}).`,
      );
    }
  }
}

export function parseAlephBuildLedger(text) {
  const parsed = JSON.parse(text);
  const releases = parsed?.releases;
  if (
    !Array.isArray(releases) ||
    !releases.every(
      (entry) =>
        typeof entry?.version === "string" &&
        Number.isInteger(entry.rebuild) &&
        typeof entry.bundleVersion === "string" &&
        /^\d+$/u.test(entry.bundleVersion),
    )
  ) {
    throw new Error(
      "Aleph build ledger must be { releases: [{ version, rebuild, bundleVersion }] }.",
    );
  }
  return { releases };
}

export function resolveDesktopBuildPlatform(nodePlatform) {
  if (nodePlatform === "darwin") {
    return "macos";
  }
  if (nodePlatform === "linux") {
    return "linux";
  }

  throw new Error(
    `Desktop builds support darwin and linux only, got ${nodePlatform}.`,
  );
}

export function createDesktopReleaseConfig(channel) {
  if (channel === "nightly") {
    return {
      appId: "dev.bb.desktop.nightly",
      applicationName: "bb Nightly",
      artifactName: "bb-nightly-${version}-${arch}.${ext}",
      iconFileName: "icon-nightly.png",
      // The Linux binary name must differ from stable so both channels can be
      // installed at once without one shadowing the other on PATH.
      linuxExecutableName: "bb-nightly",
      macIconPath: "assets/icon-nightly.icns",
      releaseTag: "desktop-nightly",
      updateMetadataFileNames: {
        linux: "nightly-linux.yml",
        macos: "nightly-mac.yml",
      },
    };
  }

  if (channel === "aleph") {
    return {
      appId: "com.generalsystemsventures.aleph",
      applicationName: "Aleph",
      artifactName: "Aleph-${version}-${arch}.${ext}",
      copyrightHolder: "General Systems Ventures",
      iconFileName: "icon.png",
      // Differs from stable so the renamed binary doesn't collide with a
      // stock bb AppImage extracted on the same PATH.
      linuxExecutableName: "aleph",
      macIconPath: "assets/icon.icns",
      releaseTag: "desktop-latest",
      updateMetadataFileNames: {
        linux: "latest-linux.yml",
        macos: "latest-mac.yml",
      },
    };
  }

  return {
    appId: "dev.bb.desktop",
    applicationName: "bb",
    artifactName: "${productName}-${version}-${arch}.${ext}",
    iconFileName: "icon.png",
    linuxExecutableName: "bb",
    macIconPath: "assets/icon.icns",
    releaseTag: "desktop-latest",
    updateMetadataFileNames: {
      linux: "latest-linux.yml",
      macos: "latest-mac.yml",
    },
  };
}
