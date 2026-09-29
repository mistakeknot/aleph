import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createDesktopReleaseInfo,
  resolveDesktopUserDataOverridePath,
} from "../src/desktop-update-provider.js";

describe("Aleph desktop release identity", () => {
  it("names the app Aleph and carries no upstream update feed", () => {
    const release = createDesktopReleaseInfo("aleph");

    expect(release.applicationName).toBe("Aleph");
    expect(release.iconFileName).toBe("icon.png");
    expect(JSON.stringify(release)).not.toContain("get-bb");
    expect("updateReleaseBaseUrl" in release).toBe(false);
  });
});

describe("Aleph userData path", () => {
  it("pins Aleph builds to the Aleph userData folder, separate from stock bb", () => {
    expect(
      resolveDesktopUserDataOverridePath({
        appDataPath: "/Users/mk/Library/Application Support",
        channel: "aleph",
      }),
    ).toBe(join("/Users/mk/Library/Application Support", "Aleph"));
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
