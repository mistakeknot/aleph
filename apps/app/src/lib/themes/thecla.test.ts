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

  it("does not reference any install-specific path or asset URL", () => {
    expect(theclaThemeCss).not.toMatch(/url\(/);
    expect(theclaThemeCss).not.toMatch(/\/home\//);
    expect(theclaThemeCss).not.toMatch(/https?:\/\//);
  });
});
