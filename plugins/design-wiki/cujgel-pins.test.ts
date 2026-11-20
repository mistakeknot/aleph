import { expect, it } from "vitest";
import { parseCujgelPage } from "./cujgel-page.js";
import { claimTargetAt, resolvePinAnchor } from "./pin-anchor.js";
import { extractClaimSites } from "./claims.js";
import { discoverWiki } from "./wiki-discovery.js";
const spec = {
  cuj_id: "sample-read-page",
  version: "1.0",
  actor: "Reader",
  trigger: "Open",
  steps: [{ step: "Read" }],
  mental_model: "Mine",
  success_condition: "Recognized",
  ambiguity_ledger: { closed_decisions: ["Keep the wording"] },
};
it("preserves page and ledger pins after moves and version changes, detaches edited claims", async () => {
  const original = parseCujgelPage({
    path: "docs/cujs/a.json",
    content: JSON.stringify(spec),
  });
  if (!original.ok) throw new Error("fixture rejected");
  expect(extractClaimSites(original.page.body)).toEqual(
    original.page.claims.map((claim) => ({
      ...claim,
      site: "strong",
      siteIndex: 0,
    })),
  );
  const pin = {
    pageId: original.page.id,
    sourcePath: original.page.path,
    claim: claimTargetAt(original.page, 0),
  };
  const moved = await discoverWiki({
    listMarkdownFiles: async () => null,
    listJsonFiles: async () => ["nested/b.json"],
    readText: async () => JSON.stringify({ ...spec, version: "2.0" }),
  });
  expect(resolvePinAnchor({ ...pin, claim: null }, moved)).toEqual({
    state: "page",
  });
  expect(resolvePinAnchor(pin, moved).state).toBe("claim");
  const edited = await discoverWiki({
    listMarkdownFiles: async () => null,
    listJsonFiles: async () => ["nested/b.json"],
    readText: async () =>
      JSON.stringify({
        ...spec,
        ambiguity_ledger: { closed_decisions: ["Changed wording"] },
      }),
  });
  expect(resolvePinAnchor(pin, edited)).toEqual({
    state: "detached",
    reason: "claim-changed",
  });
  const duplicates = await discoverWiki({
    listMarkdownFiles: async () => null,
    listJsonFiles: async () => ["a.json", "b.json"],
    readText: async () => JSON.stringify(spec),
  });
  expect(resolvePinAnchor(pin, duplicates).state).toBe("unverified");
});
