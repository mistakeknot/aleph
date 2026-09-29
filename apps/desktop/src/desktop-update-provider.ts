import { join } from "node:path";
import { isAlephAppVersion } from "@bb/config/app-update";
import type { BbDesktopVersionFeedPlatform } from "@bb/desktop-contract";

type DesktopReleaseChannel = "latest" | "nightly" | "aleph";

interface DesktopReleaseInfo {
  applicationName: "bb" | "bb Nightly" | "Aleph";
  channel: DesktopReleaseChannel;
  iconFileName: "icon.png" | "icon-nightly.png";
  releaseTag: "desktop-latest" | "desktop-nightly";
}

export function createDesktopReleaseInfo(
  channel: DesktopReleaseChannel,
): DesktopReleaseInfo {
  const nightly = channel === "nightly";
  const releaseTag = nightly ? "desktop-nightly" : "desktop-latest";

  return {
    applicationName:
      channel === "nightly"
        ? "bb Nightly"
        : channel === "aleph"
          ? "Aleph"
          : "bb",
    channel,
    iconFileName: nightly ? "icon-nightly.png" : "icon.png",
    releaseTag,
  };
}

function resolveBuiltDesktopReleaseChannel(
  rawChannel: string | undefined,
): DesktopReleaseChannel {
  if (rawChannel === undefined || rawChannel.length === 0) {
    return "latest";
  }
  if (
    rawChannel === "latest" ||
    rawChannel === "nightly" ||
    rawChannel === "aleph"
  ) {
    return rawChannel;
  }

  throw new Error(
    `Built desktop release channel must be latest, nightly, or aleph, got ${String(rawChannel)}.`,
  );
}

export function resolveDesktopUserDataOverridePath(args: {
  appDataPath: string;
  channel: DesktopReleaseChannel;
}): string | null {
  if (args.channel !== "aleph") {
    return null;
  }
  return join(args.appDataPath, "Aleph");
}

export const DESKTOP_RELEASE_CHANNEL = resolveBuiltDesktopReleaseChannel(
  process.env.BB_DESKTOP_RELEASE_CHANNEL,
);
export const DESKTOP_RELEASE_INFO = createDesktopReleaseInfo(
  DESKTOP_RELEASE_CHANNEL,
);

export interface DesktopAutoUpdateFeedConfig {
  channel: DesktopReleaseChannel;
  provider: "generic";
  url: string;
}

interface DesktopUpdateSupport {
  autoUpdate: boolean;
  versionCheck: boolean;
}

interface ResolveDesktopUpdateSupportArgs {
  appVersion: string;
  canReplaceAppImage: (appImagePath: string) => boolean;
  env: NodeJS.ProcessEnv;
  feedUrl: string | null;
  platform: BbDesktopVersionFeedPlatform;
}

export function resolveDesktopUpdateSupport(
  args: ResolveDesktopUpdateSupportArgs,
): DesktopUpdateSupport {
  if (args.feedUrl === null || isAlephAppVersion(args.appVersion)) {
    return { autoUpdate: false, versionCheck: false };
  }

  if (args.platform === "macos") {
    return { autoUpdate: true, versionCheck: true };
  }

  const appImagePath = args.env.APPIMAGE?.trim() ?? "";
  if (appImagePath.length === 0) {
    return { autoUpdate: false, versionCheck: true };
  }

  return {
    autoUpdate: args.canReplaceAppImage(appImagePath),
    versionCheck: true,
  };
}
