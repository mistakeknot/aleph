import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createDesktopAutoUpdateFeedConfig,
  createDesktopReleaseInfo,
  resolveDesktopUserDataOverridePath,
} from "../src/desktop-update-provider.js";

describe("Aleph desktop release identity", () => {
  it("names the app Aleph while keeping the bb release tag and icon", () => {
    const release = createDesktopReleaseInfo("aleph");

    expect(release.applicationName).toBe("Aleph");
    expect(release.releaseTag).toBe("desktop-latest");
    expect(release.iconFileName).toBe("icon.png");
  });

  it("has no upstream update feed for any aleph-channel path", () => {
    const release = createDesktopReleaseInfo("aleph");

    expect(release.updateReleaseBaseUrl).toBeNull();
    expect(
      createDesktopAutoUpdateFeedConfig("aleph", release.updateReleaseBaseUrl),
    ).toBeNull();
  });

  it("keeps the stable and nightly update feeds", () => {
    for (const channel of ["latest", "nightly"] as const) {
      const release = createDesktopReleaseInfo(channel);

      expect(
        createDesktopAutoUpdateFeedConfig(
          channel,
          release.updateReleaseBaseUrl,
        ),
      ).toEqual({
        channel,
        provider: "generic",
        url: `https://github.com/get-bb/bb/releases/download/${release.releaseTag}/`,
      });
    }
  });
});

describe("Aleph userData path", () => {
  it("pins Aleph builds to the bb userData folder so existing state survives the rename", () => {
    expect(
      resolveDesktopUserDataOverridePath({
        appDataPath: "/Users/mk/Library/Application Support",
        channel: "aleph",
      }),
    ).toBe(join("/Users/mk/Library/Application Support", "bb"));
  });

  it("leaves the stable and nightly channels on their own default userData path", () => {
    expect(
      resolveDesktopUserDataOverridePath({
        appDataPath: "/Users/mk/Library/Application Support",
        channel: "latest",
      }),
    ).toBeNull();
    expect(
      resolveDesktopUserDataOverridePath({
        appDataPath: "/Users/mk/Library/Application Support",
        channel: "nightly",
      }),
    ).toBeNull();
  });
});

describe("Aleph-channel module state", () => {
  it("resolves no feed URL and no auto-update feed config for a built aleph channel", async () => {
    vi.stubEnv("BB_DESKTOP_RELEASE_CHANNEL", "aleph");
    vi.resetModules();
    try {
      const provider = await import("../src/desktop-update-provider.js");

      expect(provider.DESKTOP_AUTO_UPDATE_FEED_CONFIG).toBeNull();
      expect(provider.createDesktopUpdateFeedUrl("macos")).toBeNull();
      expect(provider.createDesktopUpdateFeedUrl("linux")).toBeNull();
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });
});
