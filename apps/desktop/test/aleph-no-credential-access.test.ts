import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const scripts = [
  "aleph-build-receipt.mjs",
  "publish-release.mjs",
  "sign-aleph-release.mjs",
  "verify-aleph-release.mjs",
];
const forbidden = [
  /\.p8\b/u,
  /dump-keychain/u,
  /find-(?:generic|internet)-password/u,
  /find-identity/u,
  /store-credentials/u,
  /--apple-id/u,
  /--password/u,
  /--team-id/u,
  /CSC_LINK/u,
  /CSC_KEY_PASSWORD/u,
  /APPLE_APP_SPECIFIC_PASSWORD/u,
  /security\s+(?:export|import|unlock)/u,
  /--publish always/u,
];

describe("aleph release scripts", () => {
  it.each(scripts)(
    "%s never reaches for credentials or keychain contents",
    async (script) => {
      const text = await readFile(
        join(process.cwd(), "scripts", script),
        "utf8",
      );
      for (const pattern of forbidden) {
        expect(text).not.toMatch(pattern);
      }
    },
  );

  it("only publish-release.mjs can turn a draft release public", async () => {
    for (const script of scripts.filter(
      (name) => name !== "publish-release.mjs",
    )) {
      const text = await readFile(
        join(process.cwd(), "scripts", script),
        "utf8",
      );
      expect(text).not.toMatch(/draft|releases\//u);
    }
  });
});
