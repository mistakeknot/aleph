import type {
  CommandResult,
  CommandRunner,
} from "../../scripts/verify-aleph-release.mjs";

export const identity =
  "Developer ID Application: General Systems Ventures LLC (W964996768)";
export const goodSignature = [
  "Executable=/tmp/Aleph.app/Contents/MacOS/Aleph",
  "Identifier=com.generalsystemsventures.aleph",
  "Format=app bundle with Mach-O thin (arm64)",
  "CodeDirectory v=20500 size=1234 flags=0x10000(runtime) hashes=30+7 location=embedded",
  `Authority=${identity}`,
  "Authority=Developer ID Certification Authority",
  "Authority=Apple Root CA",
  "Timestamp=Sep 28, 2026 at 10:00:00",
  "TeamIdentifier=W964996768",
].join("\n");
export const goodDmgSignature = [
  "Identifier=Aleph-0.5.0-arm64",
  "Format=disk image",
  "CodeDirectory v=20100 size=300 flags=0x0(none) hashes=3+2 location=embedded",
  `Authority=${identity}`,
  "Authority=Developer ID Certification Authority",
  "Authority=Apple Root CA",
  "TeamIdentifier=W964996768",
].join("\n");
export const entitlementsXml = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>com.apple.security.cs.allow-jit</key><true/>
<key>com.apple.security.device.audio-input</key><true/>
</dict></plist>`;
export const expectedEntitlementKeys = [
  "com.apple.security.cs.allow-jit",
  "com.apple.security.device.audio-input",
];

export type Overrides = Partial<Record<string, CommandResult>>;

export function ok(stdout = "", stderr = ""): CommandResult {
  return { exitCode: 0, stderr, stdout };
}

export function fail(stderr: string): CommandResult {
  return { exitCode: 1, stderr, stdout: "" };
}

export function createRunner(
  overrides: Overrides = {},
  sideEffect?: (command: string, args: string[]) => Promise<void>,
): {
  calls: string[];
  runner: CommandRunner;
} {
  const calls: string[] = [];
  const runner: CommandRunner = async (command, args) => {
    const line = [command, ...args].join(" ");
    calls.push(line);
    await sideEffect?.(command, args);
    for (const [needle, result] of Object.entries(overrides)) {
      if (result !== undefined && line.includes(needle)) {
        return result;
      }
    }
    if (line.includes("codesign --verify")) {
      return ok();
    }
    if (line.includes("--entitlements")) {
      return ok(entitlementsXml);
    }
    if (line.includes("codesign -dv")) {
      return line.endsWith(".dmg")
        ? ok("", goodDmgSignature)
        : ok("", goodSignature);
    }
    if (line.includes("spctl")) {
      return ok("", "accepted\nsource=Notarized Developer ID");
    }
    if (line.includes("notarytool submit")) {
      return ok(
        JSON.stringify({
          id: `submission-${calls.length}`,
          status: "Accepted",
          message: "Processing complete",
        }),
      );
    }
    if (line.includes("stapler validate")) {
      return ok("The validate action worked!");
    }
    return ok();
  };
  return { calls, runner };
}
