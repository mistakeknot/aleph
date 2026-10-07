import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const forkDoc = readFileSync(
  new URL("../../../FORK.md", import.meta.url),
  "utf8",
);

function section(heading: string): string {
  const start = forkDoc.indexOf(`\n### ${heading}\n`);
  if (start === -1) {
    throw new Error(`FORK.md has no "${heading}" section.`);
  }
  const rest = forkDoc.slice(start + 1);
  const next = rest.slice(heading.length + 5).search(/^#{1,3} /mu);
  return next === -1 ? rest : rest.slice(0, heading.length + 5 + next);
}

describe("FORK.md signed update channel", () => {
  const channel = section("Signed update channel");

  it.each([
    "aleph-manifest/2",
    "canonical JSON",
    "aleph-update-manifest",
    "security key",
    "ssh-keygen",
    "35 days",
    "previous_digest",
    "sequence",
    "migration-required",
    "installed-revoked",
    "not-comparable",
    "persist: false",
  ])("covers %s", (term) => {
    expect(channel).toContain(term);
  });

  it("says the source-checkout updater is outside the signed channel", () => {
    expect(channel).toMatch(/source checkout/u);
    expect(channel).toMatch(/no signature or qualification check/u);
  });

  it("is linked from the Updates section", () => {
    expect(forkDoc).toContain("(#signed-update-channel)");
  });

  it.each([
    ["a home path", /\/home\/|\/Users\/[a-z]/u],
    ["a tailnet or internal host", /\.ts\.net|\.internal\b|\.local\b/u],
    ["a thread id", /\bthr_[a-z0-9]{6,}/u],
    ["a bead id", /\bmk-[a-z0-9]{4}\b/u],
    ["a ruling id", /\bq\d{3}\b/u],
  ])("does not contain %s", (_name, pattern) => {
    expect(channel).not.toMatch(pattern);
  });
});
