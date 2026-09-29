import { describe, expect, it } from "vitest";
import { resolveDesktopUpdateSupport } from "../src/desktop-update-provider.js";

const FEED_URL = "https://updates.example.test/desktop-version.json";
const APP_IMAGE_PATH = "/home/user/Apps/bb-0.37.0-x86_64.AppImage";
const alwaysReplaceable = () => true;
const neverReplaceable = () => false;

describe("desktop update support", () => {
  it("enables both update paths on macOS", () => {
    expect(
      resolveDesktopUpdateSupport({
        channel: "latest",
        canReplaceAppImage: neverReplaceable,
        env: {},
        feedUrl: FEED_URL,
        platform: "macos",
      }),
    ).toEqual({ autoUpdate: true, versionCheck: true });
  });

  it("installs updates on Linux only inside an AppImage", () => {
    expect(
      resolveDesktopUpdateSupport({
        channel: "latest",
        canReplaceAppImage: alwaysReplaceable,
        env: { APPIMAGE: APP_IMAGE_PATH },
        feedUrl: FEED_URL,
        platform: "linux",
      }),
    ).toEqual({ autoUpdate: true, versionCheck: true });
    expect(
      resolveDesktopUpdateSupport({
        channel: "latest",
        canReplaceAppImage: alwaysReplaceable,
        env: {},
        feedUrl: FEED_URL,
        platform: "linux",
      }),
    ).toEqual({ autoUpdate: false, versionCheck: true });
    expect(
      resolveDesktopUpdateSupport({
        channel: "latest",
        canReplaceAppImage: alwaysReplaceable,
        env: { APPIMAGE: "  " },
        feedUrl: FEED_URL,
        platform: "linux",
      }),
    ).toEqual({ autoUpdate: false, versionCheck: true });
  });

  it("refuses to install into an AppImage it cannot replace", () => {
    const checked: Array<string> = [];

    expect(
      resolveDesktopUpdateSupport({
        channel: "latest",
        canReplaceAppImage: (path) => {
          checked.push(path);
          return false;
        },
        env: { APPIMAGE: APP_IMAGE_PATH },
        feedUrl: FEED_URL,
        platform: "linux",
      }),
    ).toEqual({ autoUpdate: false, versionCheck: true });
    expect(checked).toEqual([APP_IMAGE_PATH]);
  });

  it("turns off both update paths for Aleph builds", () => {
    let consulted = false;

    for (const platform of ["macos", "linux"] as const) {
      expect(
        resolveDesktopUpdateSupport({
          channel: "aleph",
          canReplaceAppImage: () => {
            consulted = true;
            return true;
          },
          env: { APPIMAGE: APP_IMAGE_PATH },
          feedUrl: FEED_URL,
          platform,
        }),
      ).toEqual({ autoUpdate: false, versionCheck: false });
    }
    expect(consulted).toBe(false);
  });

  it("turns off both update paths when no update feed is configured", () => {
    for (const platform of ["macos", "linux"] as const) {
      expect(
        resolveDesktopUpdateSupport({
          channel: "latest",
          canReplaceAppImage: alwaysReplaceable,
          env: { APPIMAGE: APP_IMAGE_PATH },
          feedUrl: null,
          platform,
        }),
      ).toEqual({ autoUpdate: false, versionCheck: false });
    }
  });

  it("does not consult the filesystem on macOS", () => {
    let consulted = false;

    resolveDesktopUpdateSupport({
      channel: "latest",
      canReplaceAppImage: () => {
        consulted = true;
        return true;
      },
      env: { APPIMAGE: APP_IMAGE_PATH },
      feedUrl: FEED_URL,
      platform: "macos",
    });

    expect(consulted).toBe(false);
  });
});
