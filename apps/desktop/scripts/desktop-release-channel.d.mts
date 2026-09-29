export type DesktopReleaseChannel = "latest" | "nightly" | "aleph";
export type DesktopBuildPlatform = "macos" | "linux";

export interface DesktopUpdateMetadataFileNames {
  linux: "latest-linux.yml" | "nightly-linux.yml";
  macos: "latest-mac.yml" | "nightly-mac.yml";
}

export interface DesktopReleaseConfig {
  appId:
    | "dev.bb.desktop"
    | "dev.bb.desktop.nightly"
    | "com.generalsystemsventures.aleph";
  applicationName: "bb" | "bb Nightly" | "Aleph";
  artifactName: string;
  iconFileName: "icon.png" | "icon-nightly.png";
  linuxExecutableName: "bb" | "bb-nightly" | "aleph";
  macIconPath: "assets/icon.icns" | "assets/icon-nightly.icns";
  releaseTag: "desktop-latest" | "desktop-nightly";
  updateMetadataFileNames: DesktopUpdateMetadataFileNames;
}

export function readDesktopPackageVersion(packageJsonPath?: string): string;

export function resolveDesktopReleaseChannel(
  env: NodeJS.ProcessEnv,
  packageVersion?: string,
): DesktopReleaseChannel;

export function resolveDesktopBuildPlatform(
  nodePlatform: string,
): DesktopBuildPlatform;

export function createDesktopReleaseConfig(
  channel: DesktopReleaseChannel,
): DesktopReleaseConfig;

export function alephBundleVersion(version: string, rebuild?: number): string;

export function desktopAppVersion(
  channel: DesktopReleaseChannel,
  packageVersion: string,
): string;

export function alephUpstreamBase(packageVersion: string): string;

export interface AlephBuildLedger {
  releases: Array<{ bundleVersion: string; rebuild: number; version: string }>;
}

export function assertBundleVersionFollowsLedger(
  ledger: AlephBuildLedger,
  bundleVersion: string,
): void;

export function parseAlephBuildLedger(text: string): AlephBuildLedger;
