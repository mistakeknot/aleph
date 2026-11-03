import { describe, expect, it } from "vitest";
import { extractClaimMarkers, extractClaimSites } from "./claims.js";

describe("extractClaimSites", () => {
  it("marks bold claims as strong sites ordered along the line", () => {
    const sites = extractClaimSites(
      "**Ruled — ACME-1:** a and **Open: b** and **plain**\n",
    );
    expect(sites.map((site) => [site.site, site.siteIndex, site.label])).toEqual([
      ["strong", 0, "Ruled — ACME-1:"],
      ["strong", 1, "Open: b"],
    ]);
  });

  it("marks table cell claims with their column index", () => {
    const sites = extractClaimSites("| a | Open: question | Ruled: x |\n");
    expect(sites.map((site) => [site.site, site.siteIndex, site.label])).toEqual([
      ["cell", 1, "Open: question"],
      ["cell", 2, "Ruled: x"],
    ]);
  });

  it("keeps emphasised cell text as a cell site", () => {
    const sites = extractClaimSites("| Open: *question* | Open: **detail** |\n");
    expect(sites.map((site) => [site.site, site.siteIndex])).toEqual([
      ["cell", 0],
      ["cell", 1],
    ]);
  });

  it("does not treat a cell that starts with bold as a cell site", () => {
    const sites = extractClaimSites("| **Open: A** | x |\n");
    expect(sites.map((site) => site.site)).toEqual(["strong"]);
  });

  it("skips fenced blocks", () => {
    expect(
      extractClaimSites("```\n**Open: hidden**\n```\n**Open: shown**\n"),
    ).toHaveLength(1);
  });

  it("agrees with extractClaimMarkers on every fixture", () => {
    const body = [
      "# T",
      "",
      "**Ruled — ACME-1:** one",
      "| k | v |",
      "| --- | --- |",
      "| a | Design choice: two |",
      "| **Open: three** | x |",
      "- **Open: four** and **Open: four**",
      "",
    ].join("\n");
    const markers = extractClaimMarkers(body);
    const fromSites = extractClaimSites(body).map(
      ({ site: _site, siteIndex: _siteIndex, ...marker }) => marker,
    );
    expect(markers).toEqual(fromSites);
    expect(markers).toHaveLength(5);
  });
});
