import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { defaultAppTheme } from "@bb/domain";
import { resolveAppThemeCss, usesAmbientScreenCare } from "./index";
import { dorcasThemeCss } from "./dorcas";

function darkBlock(css: string): string {
  return css.match(/\n\.dark \{([^}]*)\}/)?.[1] ?? "";
}

const themeCss = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "../../components/ui/theme.css",
  ),
  "utf8",
);

function referenceGraph(...sheets: string[]): Map<string, Set<string>> {
  const graph = new Map<string, Set<string>>();
  for (const sheet of sheets) {
    for (const [, name, value] of sheet.matchAll(
      /(--[a-z0-9-]+|[a-z-]+)\s*:\s*([^;{}]+);/g,
    )) {
      const refs = graph.get(name) ?? new Set<string>();
      for (const [, ref] of value.matchAll(/var\((--[a-z0-9-]+)/g)) {
        refs.add(ref);
      }
      graph.set(name, refs);
    }
  }
  return graph;
}

function reaches(graph: Map<string, Set<string>>, from: string): Set<string> {
  const seen = new Set<string>();
  const pending = [...(graph.get(from) ?? [])];
  while (pending.length > 0) {
    const next = pending.pop() as string;
    if (seen.has(next)) continue;
    seen.add(next);
    pending.push(...(graph.get(next) ?? []));
  }
  return seen;
}

function isMusicDriven(name: string): boolean {
  return name.startsWith("--bb-music-") || name === "--dorcas-hue";
}

function isTextToken(name: string): boolean {
  return /^--(ink|foreground|color-foreground)$|-foreground$|-text$|^--ansi-|^--color-ansi-/.test(
    name,
  );
}

const glowRule =
  dorcasThemeCss.match(
    /\nhtml\[data-bb-music\] \[data-sidebar="sidebar"\]::after \{([^}]*)\}/,
  )?.[1] ?? "";

describe("dorcas theme", () => {
  it("resolves to its CSS through resolveAppThemeCss", () => {
    expect(resolveAppThemeCss({ ...defaultAppTheme, themeId: "dorcas" })).toBe(
      dorcasThemeCss,
    );
  });

  it("turns on ambient screen care only for dorcas", () => {
    expect(
      usesAmbientScreenCare({ ...defaultAppTheme, themeId: "dorcas" }),
    ).toBe(true);
    expect(
      usesAmbientScreenCare({ ...defaultAppTheme, themeId: "thecla" }),
    ).toBe(false);
    expect(
      usesAmbientScreenCare({
        ...defaultAppTheme,
        themeId: "mine",
        customCss: "",
      }),
    ).toBe(false);
  });

  it("keeps the dark canvas true black and the ink dimmed below white", () => {
    const dark = darkBlock(dorcasThemeCss);
    expect(dark).toContain("--canvas: #000000;");
    const ink = dark.match(/--ink: #([0-9a-f]{6});/)?.[1];
    expect(ink).toBeDefined();
    const channels = [0, 2, 4].map((at) =>
      Number.parseInt(ink?.slice(at, at + 2) ?? "ff", 16),
    );
    expect(Math.max(...channels)).toBeLessThanOrEqual(0xd8);
  });

  it("keeps drifting tokens out of the static mode blocks that mobile reads", () => {
    expect(darkBlock(dorcasThemeCss)).not.toContain("var(");
    expect(dorcasThemeCss).toMatch(
      /html\.dark \{[^}]*--border: var\(--dorcas-line\);/,
    );
    expect(dorcasThemeCss).toContain("var(--bb-ambient-wave, 0)");
  });

  it("dims idle windows and drops the dimming under forced colors", () => {
    expect(dorcasThemeCss).toMatch(/html\[data-bb-ambient-idle\]::after \{/);
    expect(dorcasThemeCss).toMatch(
      /@media \(forced-colors: active\) \{[^@]*html\[data-bb-ambient-idle\]::after \{ display: none; \}/,
    );
  });

  it("does not reference any install-specific path or absolute asset URL", () => {
    expect(dorcasThemeCss).not.toMatch(/\/home\//);
    expect(dorcasThemeCss).not.toMatch(/https?:\/\//);
  });

  it("fades resting chrome, keeps it on hover or focus, and not under forced colors", () => {
    expect(dorcasThemeCss).toContain(
      'html[data-bb-ambient-rest] [data-sidebar="sidebar"]:not(:hover, :focus-within),',
    );
    expect(dorcasThemeCss).toContain(
      "html[data-bb-ambient-rest] header[data-app-page-header]:not(:hover, :focus-within) {\n  opacity: .3;",
    );
    expect(dorcasThemeCss).toMatch(
      /@media \(forced-colors: active\) \{[^@]*header\[data-app-page-header\]:not\(:hover, :focus-within\) \{ opacity: 1; \}/,
    );
  });

  it("lets music mode take over the hue and falls back to the ambient wave", () => {
    expect(dorcasThemeCss).toContain(
      "--dorcas-hue: var(--bb-music-hue, calc(350 - 125 * var(--bb-ambient-wave, 0)));",
    );
  });

  it("never lets a text or ink token resolve through a music-driven value", () => {
    const graph = referenceGraph(themeCss, dorcasThemeCss);
    const textTokens = [...graph.keys()].filter(isTextToken);
    expect(textTokens).toEqual(
      expect.arrayContaining([
        "--ink",
        "--foreground",
        "--muted-foreground",
        "--sidebar-foreground",
        "--color-foreground",
        "--destructive-text",
      ]),
    );
    const leaks = textTokens.filter((token) =>
      [...reaches(graph, token)].some(isMusicDriven),
    );
    expect(leaks).toEqual([]);
    for (const property of ["color", "fill", "stroke", "caret-color"]) {
      expect([...reaches(graph, property)].filter(isMusicDriven)).toEqual([]);
    }
  });

  it("drives only lines, seams, input outlines and washes from the music hue", () => {
    const graph = referenceGraph(themeCss, dorcasThemeCss);
    for (const token of [
      "--dorcas-line",
      "--dorcas-wash",
      "--border",
      "--border-seam",
      "--input",
    ]) {
      expect(reaches(graph, token)).toContain("--bb-music-hue");
    }
    const driven = [...graph.keys()].filter(
      (name) =>
        name.startsWith("--") &&
        !isMusicDriven(name) &&
        [...reaches(graph, name)].includes("--bb-music-hue"),
    );
    expect(driven.filter(isTextToken)).toEqual([]);
  });

  it("draws the glow as an opacity-only strip with a bounded static shadow", () => {
    expect(glowRule).not.toBe("");
    expect(glowRule).toContain("width: 2px;");
    expect(glowRule).toContain("background-color: var(--dorcas-line);");
    expect(glowRule).toContain("opacity: var(--bb-music-glow, 0);");
    expect(glowRule).toContain("pointer-events: none;");
    expect(glowRule).not.toMatch(/transition|animation|transform/);
    const shadow = /box-shadow: 0 0 (\d+)px (\d+)px var\(--dorcas-line\);/.exec(
      glowRule,
    );
    expect(shadow).not.toBeNull();
    const [blur, spread] = [Number(shadow?.[1]), Number(shadow?.[2])];
    expect(blur).toBeLessThanOrEqual(8);
    expect(spread).toBeLessThanOrEqual(2);
    expect(2 + blur + spread).toBeLessThanOrEqual(12);
    expect(dorcasThemeCss.match(/--bb-music-glow/g)).toHaveLength(1);
  });

  it("hides the glow under reduced motion and forced colors", () => {
    for (const query of [
      "prefers-reduced-motion: reduce",
      "forced-colors: active",
    ]) {
      const block =
        dorcasThemeCss.split(`@media (${query}) {`)[1]?.split("\n}")[0] ?? "";
      expect(block).toContain(
        'html[data-bb-music] [data-sidebar="sidebar"]::after { display: none; }',
      );
    }
  });
});
