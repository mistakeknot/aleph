import { describe, expect, it } from "vitest";
import {
  BUILTIN_THEME_IDS,
  builtInThemes,
  defaultAppTheme,
  isBuiltInThemeId,
  NEW_INSTALL_DEFAULT_THEME_ID,
} from "../src/app-theme.js";

describe("built-in themes", () => {
  it("lists thecla as a built-in theme", () => {
    expect(BUILTIN_THEME_IDS).toContain("thecla");
    expect(isBuiltInThemeId("thecla")).toBe(true);
    expect(builtInThemes.find((theme) => theme.id === "thecla")).toMatchObject({
      id: "thecla",
      name: "Thecla",
    });
  });

  it("picks thecla as the new-install default without changing what an explicit Default choice means", () => {
    expect(NEW_INSTALL_DEFAULT_THEME_ID).toBe("thecla");
    expect(defaultAppTheme.themeId).toBe("default");
  });
});
