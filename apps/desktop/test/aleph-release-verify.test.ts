import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  verifyAlephApp,
  verifyAlephDmg,
  verifyAlephZip,
} from "../scripts/verify-aleph-release.mjs";
import {
  createRunner,
  expectedEntitlementKeys,
  fail,
  goodDmgSignature,
  goodSignature,
  identity,
  ok,
  type Overrides,
  entitlementsXml,
} from "./helpers/aleph-fake-runner.js";

async function verifyApp(overrides: Overrides): Promise<string[]> {
  const { runner } = createRunner(overrides);
  const result = await verifyAlephApp({
    appPath: "/tmp/Aleph.app",
    expectedEntitlementKeys,
    runner,
  });
  return result.failures;
}

describe("verifyAlephApp", () => {
  it("accepts a Developer ID signed, hardened, notarized and stapled app", async () => {
    const { calls, runner } = createRunner();
    const result = await verifyAlephApp({
      appPath: "/tmp/Aleph.app",
      expectedEntitlementKeys,
      runner,
    });

    expect(result.failures).toEqual([]);
    expect(result.teamIdentifier).toBe("W964996768");
    expect(calls.some((call) => call.includes("stapler validate"))).toBe(true);
    expect(
      calls.some((call) =>
        call.includes("codesign --verify --deep --strict --verbose=2"),
      ),
    ).toBe(true);
    expect(calls.some((call) => call.includes("spctl -a -t exec -vv"))).toBe(
      true,
    );
  });

  it("fails when the expected Developer ID authority is absent", async () => {
    const failures = await verifyApp({
      "codesign -dv": ok(
        "",
        goodSignature.replace(
          identity,
          "Apple Development: someone (ABCDE12345)",
        ),
      ),
    });

    expect(failures.join("\n")).toContain("Developer ID Application");
  });

  it("fails on the wrong team identifier", async () => {
    const failures = await verifyApp({
      "codesign -dv": ok(
        "",
        goodSignature.replace(
          "TeamIdentifier=W964996768",
          "TeamIdentifier=Z45MLNQK64",
        ),
      ),
    });

    expect(failures.join("\n")).toContain("TeamIdentifier");
  });

  it("fails on an ad-hoc or unsigned app", async () => {
    const adhoc = await verifyApp({
      "codesign -dv": ok(
        "",
        "Identifier=com.generalsystemsventures.aleph\nSignature=adhoc\nTeamIdentifier=not set",
      ),
    });
    const unsigned = await verifyApp({
      "codesign -dv": fail("Aleph.app: code object is not signed at all"),
    });

    expect(adhoc.join("\n")).toContain("ad-hoc");
    expect(unsigned.join("\n")).toContain("unsigned");
  });

  it("fails when the hardened runtime flag is missing", async () => {
    const failures = await verifyApp({
      "codesign -dv": ok(
        "",
        goodSignature.replace("flags=0x10000(runtime)", "flags=0x0(none)"),
      ),
    });

    expect(failures.join("\n")).toContain("hardened runtime");
  });

  it("fails on the wrong bundle identifier", async () => {
    const failures = await verifyApp({
      "codesign -dv": ok(
        "",
        goodSignature.replace(
          "Identifier=com.generalsystemsventures.aleph",
          "Identifier=dev.bb.desktop",
        ),
      ),
    });

    expect(failures.join("\n")).toContain("Identifier");
  });

  it("fails when strict deep verification fails", async () => {
    const failures = await verifyApp({
      "codesign --verify": fail("a sealed resource is missing or invalid"),
    });

    expect(failures.join("\n")).toContain("codesign --verify");
  });

  it("fails when the notarization ticket is not stapled", async () => {
    const failures = await verifyApp({
      "stapler validate": fail(
        "Processing: Aleph.app does not have a ticket stapled to it.",
      ),
    });

    expect(failures.join("\n")).toContain("stapl");
  });

  it("fails when Gatekeeper does not report a notarized Developer ID source", async () => {
    const failures = await verifyApp({
      spctl: ok("", "accepted\nsource=Developer ID"),
    });

    expect(failures.join("\n")).toContain("Notarized Developer ID");
  });

  it("fails when Gatekeeper rejects the app", async () => {
    const failures = await verifyApp({
      spctl: fail("rejected\nsource=no usable signature"),
    });

    expect(failures.join("\n")).toContain("spctl");
  });

  it("fails when the entitlements differ from the allowlist", async () => {
    const failures = await verifyApp({
      "--entitlements": ok(
        entitlementsXml.replace(
          "</dict>",
          "<key>com.apple.security.cs.disable-library-validation</key><true/></dict>",
        ),
      ),
    });

    expect(failures.join("\n")).toContain(
      "com.apple.security.cs.disable-library-validation",
    );
  });

  it("reports every failure, not only the first", async () => {
    const failures = await verifyApp({
      "stapler validate": fail("no ticket"),
      spctl: fail("rejected"),
    });

    expect(failures.length).toBeGreaterThanOrEqual(2);
  });

  it("never reads keychain contents or notary credentials", async () => {
    const { calls, runner } = createRunner();
    await verifyAlephApp({
      appPath: "/tmp/Aleph.app",
      expectedEntitlementKeys,
      runner,
    });

    for (const call of calls) {
      expect(call).not.toMatch(
        /find-(?:generic|internet)-password|dump-keychain|export|\.p8|--password|--apple-id|store-credentials/u,
      );
    }
  });
});

describe("verifyAlephDmg", () => {
  it("accepts a signed, notarized and stapled disk image", async () => {
    const { runner } = createRunner();
    const result = await verifyAlephDmg({ dmgPath: "/tmp/Aleph.dmg", runner });

    expect(result.failures).toEqual([]);
  });

  it("fails when the disk image is not stapled", async () => {
    const { runner } = createRunner({ "stapler validate": fail("no ticket") });
    const result = await verifyAlephDmg({ dmgPath: "/tmp/Aleph.dmg", runner });

    expect(result.failures.join("\n")).toContain("stapl");
  });

  it("fails when the disk image is signed by another team", async () => {
    const { runner } = createRunner({
      "codesign -dv": ok(
        "",
        goodDmgSignature.replace(
          "TeamIdentifier=W964996768",
          "TeamIdentifier=ABCDE12345",
        ),
      ),
    });
    const result = await verifyAlephDmg({ dmgPath: "/tmp/Aleph.dmg", runner });

    expect(result.failures.join("\n")).toContain("TeamIdentifier");
  });
});

describe("verifyAlephZip", () => {
  it("extracts the archive and verifies the app inside, which proves it came from the stapled app", async () => {
    const { calls, runner } = createRunner();
    const result = await verifyAlephZip({
      expectedEntitlementKeys,
      extractDirectory: "/tmp/extract",
      runner,
      zipPath: "/tmp/Aleph.zip",
    });

    expect(result.failures).toEqual([]);
    expect(calls[0]).toBe("ditto -x -k /tmp/Aleph.zip /tmp/extract");
    expect(
      calls.some((call) =>
        call.includes("stapler validate /tmp/extract/Aleph.app"),
      ),
    ).toBe(true);
  });

  it("fails when the archive was built from an unstapled app", async () => {
    const { runner } = createRunner({ "stapler validate": fail("no ticket") });
    const result = await verifyAlephZip({
      expectedEntitlementKeys,
      extractDirectory: "/tmp/extract",
      runner,
      zipPath: "/tmp/Aleph.zip",
    });

    expect(result.failures.join("\n")).toContain("stapl");
  });

  it("fails when extraction fails", async () => {
    const { runner } = createRunner({ ditto: fail("bad zip") });
    const result = await verifyAlephZip({
      expectedEntitlementKeys,
      extractDirectory: "/tmp/extract",
      runner,
      zipPath: "/tmp/Aleph.zip",
    });

    expect(result.failures.join("\n")).toContain("extract");
  });
});

describe("unpublishable builds", () => {
  it("fails an app whose Info.plist carries the unpublishable marker", async () => {
    const root = await mkdtemp(join(tmpdir(), "aleph-verify-marker-"));
    try {
      const app = join(root, "Aleph.app");
      await mkdir(join(app, "Contents"), { recursive: true });
      await writeFile(
        join(app, "Contents", "Info.plist"),
        "<plist><dict><key>AlephUnpublishable</key><true/></dict></plist>",
      );
      const { runner } = createRunner();
      const result = await verifyAlephApp({
        appPath: app,
        expectedEntitlementKeys,
        runner,
      });

      expect(result.failures.join("\n")).toContain("AlephUnpublishable");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("fails an app whose package metadata carries the marker", async () => {
    const root = await mkdtemp(join(tmpdir(), "aleph-verify-marker-"));
    try {
      const app = join(root, "Aleph.app");
      await mkdir(join(app, "Contents", "Resources", "app"), {
        recursive: true,
      });
      await writeFile(
        join(app, "Contents", "Resources", "app", "package.json"),
        '{"AlephUnpublishable":true}',
      );
      const { runner } = createRunner();
      const result = await verifyAlephApp({
        appPath: app,
        expectedEntitlementKeys,
        runner,
      });

      expect(result.failures.join("\n")).toContain("AlephUnpublishable");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("fails DMG and ZIP artifacts named UNPUBLISHABLE", async () => {
    const { runner } = createRunner();
    const dmg = await verifyAlephDmg({
      dmgPath: "/tmp/Aleph-UNPUBLISHABLE-0.5.0.dmg",
      runner,
    });
    const zip = await verifyAlephZip({
      expectedEntitlementKeys,
      extractDirectory: "/tmp/extract",
      runner,
      zipPath: "/tmp/Aleph-UNPUBLISHABLE-0.5.0.zip",
    });

    expect(dmg.failures.join("\n")).toContain("UNPUBLISHABLE");
    expect(zip.failures.join("\n")).toContain("UNPUBLISHABLE");
  });
});
