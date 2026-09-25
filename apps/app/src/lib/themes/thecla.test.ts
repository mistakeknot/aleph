import { describe, expect, it } from "vitest";
import { defaultAppTheme } from "@bb/domain";
import { resolveAppThemeCss } from "./index";
import { theclaThemeCss } from "./thecla";

describe("thecla theme", () => {
  it("resolves to its CSS through resolveAppThemeCss", () => {
    expect(resolveAppThemeCss({ ...defaultAppTheme, themeId: "thecla" })).toBe(
      theclaThemeCss,
    );
  });

  it("does not reference any install-specific path or absolute asset URL", () => {
    expect(theclaThemeCss).not.toMatch(/\/home\//);
    expect(theclaThemeCss).not.toMatch(/https?:\/\//);
  });

  it("declares Ioskeley Mono with a served fallback and a real font stack", () => {
    expect(theclaThemeCss).toMatch(
      /@font-face\s*{\s*font-family:\s*"Ioskeley Mono";/,
    );
    expect(theclaThemeCss).toMatch(/local\("Ioskeley Mono"\)/);
    expect(theclaThemeCss).toMatch(
      /url\("\/api\/v1\/system\/fonts\/ioskeley-mono\.woff2"\)\s*format\("woff2"\)/,
    );
    expect(theclaThemeCss).toContain(
      '--font-sans: "Ioskeley Mono", Iosevka, "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;',
    );
  });
});
