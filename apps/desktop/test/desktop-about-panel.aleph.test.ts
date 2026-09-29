import { describe, expect, it } from "vitest";
import {
  buildDesktopAboutDetails,
  createDesktopAboutPanelOptions,
  type DesktopAboutFacts,
} from "../src/desktop-about-panel.js";

function aboutFacts(overrides: Partial<DesktopAboutFacts>): DesktopAboutFacts {
  return {
    applicationName: "Aleph",
    buildDate: "2026-09-27",
    channel: "aleph",
    commit: "abc1234",
    electronVersion: "38.0.0",
    osArch: "arm64",
    osRelease: "25.0.0",
    osType: "Darwin",
    platform: "darwin",
    pluginSdkVersion: "0.9.0",
    version: "0.43.4+aleph.0.4.1",
    ...overrides,
  };
}

describe("desktop About version", () => {
  it("leads an Aleph build's version with its Aleph release", () => {
    const facts = aboutFacts({});
    expect(createDesktopAboutPanelOptions(facts).applicationVersion).toBe(
      "0.4.1 (0.43.4+aleph.0.4.1)",
    );
    expect(buildDesktopAboutDetails(facts, null)).toContain(
      "Version: 0.4.1 (0.43.4+aleph.0.4.1)\n",
    );
  });

  it.each([
    ["an older Aleph build number", "aleph", "0.43.4+aleph.4"],
    ["a plain Aleph release", "aleph", "0.5.0"],
    ["a stock build", "latest", "0.43.4"],
  ] as const)("keeps %s's raw version", (_label, channel, version) => {
    expect(
      createDesktopAboutPanelOptions(aboutFacts({ channel, version }))
        .applicationVersion,
    ).toBe(version);
  });
});
