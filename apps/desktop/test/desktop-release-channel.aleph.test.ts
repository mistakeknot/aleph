import { describe, expect, it } from "vitest";
import {
  createDesktopReleaseConfig,
  resolveDesktopReleaseChannel,
} from "../scripts/desktop-release-channel.mjs";

describe("desktop release channel for Aleph builds", () => {
  it("derives the aleph channel from an Aleph-suffixed package version", () => {
    expect(resolveDesktopReleaseChannel({}, "0.43.4+aleph.2")).toBe("aleph");
  });

  it("falls back to latest for an upstream package version", () => {
    expect(resolveDesktopReleaseChannel({}, "0.43.4")).toBe("latest");
  });

  it("lets an explicit channel override the version-derived default", () => {
    expect(
      resolveDesktopReleaseChannel(
        { BB_DESKTOP_RELEASE_CHANNEL: "latest" },
        "0.43.4+aleph.2",
      ),
    ).toBe("latest");
    expect(
      resolveDesktopReleaseChannel(
        { BB_DESKTOP_RELEASE_CHANNEL: "aleph" },
        "0.43.4",
      ),
    ).toBe("aleph");
  });

  it("keeps the bb bundle identity but renames the app, artifact, and Linux binary", () => {
    const config = createDesktopReleaseConfig("aleph");

    expect(config).toMatchObject({
      appId: "dev.bb.desktop",
      applicationName: "Aleph",
      artifactName: "Aleph-${version}-${arch}.${ext}",
      linuxExecutableName: "aleph",
    });
  });
});
