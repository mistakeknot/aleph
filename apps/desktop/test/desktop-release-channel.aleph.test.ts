import { describe, expect, it } from "vitest";
import {
  alephBundleVersion,
  alephUpstreamBase,
  assertBundleVersionFollowsLedger,
  desktopAppVersion,
  parseAlephBuildLedger,
  readDesktopPackageVersion,
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

  it("accepts an explicit channel that agrees with the package version", () => {
    expect(
      resolveDesktopReleaseChannel(
        { BB_DESKTOP_RELEASE_CHANNEL: "aleph" },
        "0.43.4",
      ),
    ).toBe("aleph");
    expect(
      resolveDesktopReleaseChannel(
        { BB_DESKTOP_RELEASE_CHANNEL: "aleph" },
        "0.44.0+aleph.0.5.0",
      ),
    ).toBe("aleph");
  });

  it("refuses an explicit non-Aleph channel on an Aleph package version", () => {
    for (const channel of ["latest", "nightly"]) {
      expect(() =>
        resolveDesktopReleaseChannel(
          { BB_DESKTOP_RELEASE_CHANNEL: channel },
          "0.44.0+aleph.0.5.0",
        ),
      ).toThrow(/contradicts the Aleph package version/);
    }
  });

  it("still lets stock packages pin any channel explicitly", () => {
    expect(
      resolveDesktopReleaseChannel(
        { BB_DESKTOP_RELEASE_CHANNEL: "nightly" },
        "0.44.0",
      ),
    ).toBe("nightly");
  });

  it("uses the Aleph bundle identity and renames the app, artifact, and Linux binary", () => {
    const config = createDesktopReleaseConfig("aleph");

    expect(config).toMatchObject({
      appId: "com.generalsystemsventures.aleph",
      applicationName: "Aleph",
      artifactName: "Aleph-${version}-${arch}.${ext}",
      linuxExecutableName: "aleph",
    });
  });
});

describe("Aleph monotonic CFBundleVersion", () => {
  it("maps the Aleph release to an integer that starts at 50000 for 0.5.0", () => {
    expect(alephBundleVersion("0.44.0+aleph.0.5.0")).toBe("50000");
    expect(alephBundleVersion("0.44.0+aleph.0.5.1")).toBe("50100");
    expect(alephBundleVersion("0.44.0+aleph.1.0.0")).toBe("1000000");
  });

  it("orders strictly by Aleph release, not by upstream base", () => {
    const versions = [
      "0.43.4+aleph.0.4.1",
      "0.44.0+aleph.0.5.0",
      "0.44.0+aleph.0.5.1",
      "0.44.0+aleph.0.6.0",
      "0.45.0+aleph.1.0.0",
    ];
    const ids = versions.map((version) => Number(alephBundleVersion(version)));
    expect([...ids].sort((a, b) => a - b)).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("reads a legacy +aleph.<n> build as 0.n.0", () => {
    expect(alephBundleVersion("0.43.4+aleph.4")).toBe("40000");
  });

  it("adds a per-release rebuild counter without reordering releases", () => {
    expect(alephBundleVersion("0.44.0+aleph.0.5.0", 3)).toBe("50003");
    expect(Number(alephBundleVersion("0.44.0+aleph.0.5.0", 99))).toBeLessThan(
      Number(alephBundleVersion("0.44.0+aleph.0.5.1")),
    );
  });

  it("refuses versions and counters that would break monotonicity", () => {
    expect(() => alephBundleVersion("0.44.0")).toThrow(/Aleph version/);
    expect(() => alephBundleVersion("0.44.0+aleph.0.100.0")).toThrow(/100/);
    expect(() => alephBundleVersion("0.44.0+aleph.0.5.100")).toThrow(/100/);
    expect(() => alephBundleVersion("0.44.0+aleph.0.5.0", 100)).toThrow(
      /rebuild/,
    );
    expect(() => alephBundleVersion("0.44.0+aleph.0.5.0", -1)).toThrow(
      /rebuild/,
    );
  });
});

describe("Aleph app version and ledger", () => {
  it("reads the checked-in package version without arguments", () => {
    expect(readDesktopPackageVersion()).toMatch(/\+aleph\./);
  });

  it("reports the plain Aleph release so SemVer orders releases", () => {
    expect(desktopAppVersion("aleph", "0.44.0+aleph.0.5.0")).toBe("0.5.0");
    expect(desktopAppVersion("aleph", "0.43.4+aleph.4")).toBe("0.4.0");
    expect(desktopAppVersion("latest", "0.44.0")).toBe("0.44.0");
    expect(alephUpstreamBase("0.44.0+aleph.0.5.0")).toBe("0.44.0");
  });

  const ledger = parseAlephBuildLedger(
    JSON.stringify({
      releases: [{ bundleVersion: "50000", rebuild: 0, version: "0.5.0" }],
    }),
  );

  it("accepts a strictly greater CFBundleVersion", () => {
    expect(() =>
      assertBundleVersionFollowsLedger(ledger, "50001"),
    ).not.toThrow();
    expect(() =>
      assertBundleVersionFollowsLedger(ledger, "50100"),
    ).not.toThrow();
  });

  it("rejects an equal or lower CFBundleVersion", () => {
    expect(() => assertBundleVersionFollowsLedger(ledger, "50000")).toThrow(
      /already ledgered/,
    );
    expect(() => assertBundleVersionFollowsLedger(ledger, "40100")).toThrow(
      /not greater/,
    );
  });

  it("rejects a malformed ledger", () => {
    expect(() => parseAlephBuildLedger('{"releases":[{"version":1}]}')).toThrow(
      /ledger must be/,
    );
  });
});
