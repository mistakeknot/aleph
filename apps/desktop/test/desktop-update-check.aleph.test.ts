import { describe, expect, it, vi } from "vitest";
import type { BbDesktopVersionFeed } from "@bb/desktop-contract";
import {
  createDesktopUpdateService,
  parseDesktopVersionFeed,
} from "../src/desktop-update-check.js";

function feedText(version: string): string {
  const feed: BbDesktopVersionFeed = {
    channel: "latest",
    files: [
      {
        sha512: "BASE64_SHA512_FROM_ELECTRON_BUILDER",
        size: 123456789,
        url: `bb-${version}-universal.zip`,
      },
    ],
    minimumSystemVersion: null,
    path: `bb-${version}-universal.zip`,
    platform: "macos",
    releaseDate: "2026-09-24T00:00:00.000Z",
    releaseName: `bb desktop ${version}`,
    releaseNotes: null,
    schemaVersion: 1,
    sha512: "BASE64_SHA512_FROM_ELECTRON_BUILDER",
    stagingPercentage: null,
    version,
  };
  return JSON.stringify(feed);
}

function updateAvailable(feedVersion: string): boolean {
  const result = parseDesktopVersionFeed({
    channel: "latest",
    checkedAt: "2026-09-24T00:00:00.000Z",
    currentVersion: "0.43.4+aleph.1",
    payloadText: feedText(feedVersion),
    platform: "macos",
  });
  if (result.kind !== "valid") throw new Error(result.reason);
  return result.info.updateAvailable;
}

describe("feed parsing of Aleph build-metadata versions", () => {
  it("treats the upstream base release as the same version", () => {
    expect(updateAvailable("0.43.4")).toBe(false);
  });

  it("ranks a newer upstream release above an Aleph build, which is why Aleph builds turn the check off", () => {
    expect(updateAvailable("0.43.5")).toBe(true);
  });

  it("does not order Aleph builds of the same upstream release", () => {
    expect(updateAvailable("0.43.4+aleph.2")).toBe(false);
  });
});

describe("update service without a feed", () => {
  it("never fetches when the channel has no feed, even if enabled", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}"));
    const service = createDesktopUpdateService({
      channel: "latest",
      currentVersion: "0.45.0+aleph.0.6.0",
      enabled: true,
      feedUrl: null,
      fetchImpl,
      logger: { warn: () => {} },
      platform: "macos",
    });

    await service.checkForUpdates();

    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
