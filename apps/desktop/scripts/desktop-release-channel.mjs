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

function readDesktopPackageVersion() {
  const packageJson = JSON.parse(
    readFileSync(DESKTOP_PACKAGE_JSON_PATH, "utf8"),
  );
  return packageJson.version;
}

export function resolveDesktopReleaseChannel(
  env,
  packageVersion = readDesktopPackageVersion(),
) {
  const rawChannel = env[DESKTOP_RELEASE_CHANNEL_ENV_NAME]?.trim();
  if (rawChannel === undefined || rawChannel.length === 0) {
    return isAlephDesktopVersion(packageVersion) ? "aleph" : "latest";
  }
  if (
    rawChannel === "latest" ||
    rawChannel === "nightly" ||
    rawChannel === "aleph"
  ) {
    return rawChannel;
  }

  throw new Error(
    `${DESKTOP_RELEASE_CHANNEL_ENV_NAME} must be latest, nightly, or aleph, got ${rawChannel}.`,
  );
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
      // Same bundle id as stable: an Aleph build replaces stock bb on a Mac
      // rather than sitting next to it (see FORK.md), and keeping the id
      // unchanged preserves Keychain-backed safeStorage secrets and any
      // already-granted TCC permissions across the rename.
      appId: "dev.bb.desktop",
      applicationName: "Aleph",
      artifactName: "Aleph-${version}-${arch}.${ext}",
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

export function createDesktopUpdateReleaseBaseUrl(releaseTag) {
  return `https://github.com/get-bb/bb/releases/download/${releaseTag}/`;
}
