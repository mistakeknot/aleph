import { describe, expect, it } from "vitest";
import { defaultAppTheme } from "@bb/domain";
import { resolveAppThemeCss, usesAmbientScreenCare } from "./index";
import { dorcasThemeCss } from "./dorcas";

function darkBlock(css: string): string {
  return css.match(/\n\.dark \{([^}]*)\}/)?.[1] ?? "";
}

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
});
