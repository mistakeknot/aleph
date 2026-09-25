import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
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
