import { describe, expect, it } from "vitest";
import {
  createDesktopUpdateFeedUrl,
  resolveDesktopUpdateSupport,
} from "../src/desktop-update-provider.js";

describe("desktop update feed url", () => {
  it("gives each platform its own feed file inside one release tag", () => {
    expect(createDesktopUpdateFeedUrl("macos")).toBe(
      "https://github.com/get-bb/bb/releases/download/desktop-latest/desktop-version.json",
    );
    expect(createDesktopUpdateFeedUrl("linux")).toBe(
      "https://github.com/get-bb/bb/releases/download/desktop-latest/desktop-version-linux.json",
    );
  });
});

const UPSTREAM_VERSION = "0.43.4";
const APP_IMAGE_PATH = "/home/user/Apps/bb-0.37.0-x86_64.AppImage";
const alwaysReplaceable = () => true;
const neverReplaceable = () => false;

describe("desktop update support", () => {
  it("enables both update paths on macOS", () => {
    expect(
      resolveDesktopUpdateSupport({
        appVersion: UPSTREAM_VERSION,
        canReplaceAppImage: neverReplaceable,
        env: {},
        platform: "macos",
      }),
    ).toEqual({ autoUpdate: true, versionCheck: true });
  });

  it("installs updates on Linux only inside an AppImage", () => {
    expect(
      resolveDesktopUpdateSupport({
        appVersion: UPSTREAM_VERSION,
        canReplaceAppImage: alwaysReplaceable,
        env: { APPIMAGE: APP_IMAGE_PATH },
        platform: "linux",
      }),
    ).toEqual({ autoUpdate: true, versionCheck: true });
    expect(
      resolveDesktopUpdateSupport({
        appVersion: UPSTREAM_VERSION,
        canReplaceAppImage: alwaysReplaceable,
        env: {},
        platform: "linux",
      }),
    ).toEqual({ autoUpdate: false, versionCheck: true });
    expect(
      resolveDesktopUpdateSupport({
        appVersion: UPSTREAM_VERSION,
        canReplaceAppImage: alwaysReplaceable,
        env: { APPIMAGE: "  " },
        platform: "linux",
      }),
    ).toEqual({ autoUpdate: false, versionCheck: true });
  });

  it("refuses to install into an AppImage it cannot replace", () => {
    const checked: Array<string> = [];

    expect(
      resolveDesktopUpdateSupport({
        appVersion: UPSTREAM_VERSION,
        canReplaceAppImage: (path) => {
          checked.push(path);
          return false;
        },
        env: { APPIMAGE: APP_IMAGE_PATH },
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
          appVersion: "0.43.4+aleph.1",
          canReplaceAppImage: () => {
            consulted = true;
            return true;
          },
          env: { APPIMAGE: APP_IMAGE_PATH },
          platform,
        }),
      ).toEqual({ autoUpdate: false, versionCheck: false });
    }
    expect(consulted).toBe(false);
  });

  it("does not consult the filesystem on macOS", () => {
    let consulted = false;

    resolveDesktopUpdateSupport({
      appVersion: UPSTREAM_VERSION,
      canReplaceAppImage: () => {
        consulted = true;
        return true;
      },
      env: { APPIMAGE: APP_IMAGE_PATH },
      platform: "macos",
    });

    expect(consulted).toBe(false);
  });
});
