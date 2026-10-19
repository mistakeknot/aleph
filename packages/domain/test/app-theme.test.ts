import { describe, expect, it } from "vitest";
import {
  appThemeSchema,
  appThemeSelectionSchema,
  BUILTIN_THEME_IDS,
  builtInThemes,
  DEFAULT_MUSIC_PORT,
  defaultAppTheme,
  isBuiltInThemeId,
  MUSIC_MODE_THEME_ID,
  musicPortSchema,
  musicSecretSchema,
  NEW_INSTALL_DEFAULT_THEME_ID,
  themeSelectionFrom,
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

  it("lists dorcas as a built-in theme", () => {
    expect(isBuiltInThemeId("dorcas")).toBe(true);
    expect(builtInThemes.find((theme) => theme.id === "dorcas")).toMatchObject({
      id: "dorcas",
      name: "Dorcas",
    });
  });

  it("picks thecla as the new-install default without changing what an explicit Default choice means", () => {
    expect(NEW_INSTALL_DEFAULT_THEME_ID).toBe("thecla");
    expect(defaultAppTheme.themeId).toBe("default");
  });
});

function base64Of(bytes: readonly number[]): string {
  return btoa(String.fromCharCode(...bytes));
}

function repeated(length: number): number[] {
  return Array.from({ length }, () => 7);
}

describe("music mode theme preferences", () => {
  const secret = base64Of(repeated(32));

  it("defaults music mode off with the Phosphene port and no secret", () => {
    const parsed = appThemeSchema.parse({
      themeId: "dorcas",
      customCss: null,
      faviconColor: "default",
    });
    expect(parsed).toMatchObject({
      musicMode: false,
      musicPort: 47_615,
      musicSecret: null,
    });
    expect(defaultAppTheme).toMatchObject({
      musicMode: false,
      musicPort: DEFAULT_MUSIC_PORT,
      musicSecret: null,
    });
  });

  it("round-trips the music fields through the theme and selection schemas", () => {
    const theme = appThemeSchema.parse({
      ...defaultAppTheme,
      themeId: "dorcas",
      musicMode: true,
      musicPort: 50_000,
      musicSecret: "set",
    });
    expect(appThemeSchema.parse(JSON.parse(JSON.stringify(theme)))).toEqual(
      theme,
    );
    expect(
      appThemeSelectionSchema.parse(themeSelectionFrom(theme, "nord")),
    ).toEqual({
      themeId: "nord",
      faviconColor: "default",
      musicMode: true,
      musicPort: 50_000,
    });
  });

  it("requires the music fields in a theme selection", () => {
    expect(
      appThemeSelectionSchema.safeParse({
        themeId: "dorcas",
        faviconColor: "default",
      }).success,
    ).toBe(false);
  });

  it("bounds the port to unprivileged integers", () => {
    for (const port of [1023, 65_536, 47_615.5, 0]) {
      expect(musicPortSchema.safeParse(port).success).toBe(false);
    }
    for (const port of [1024, 47_615, 65_535]) {
      expect(musicPortSchema.safeParse(port).success).toBe(true);
    }
  });

  it("accepts only canonical base64 of exactly 32 bytes as the secret", () => {
    const varied = base64Of(Array.from({ length: 32 }, (_, i) => 255 - i));
    expect(varied).toMatch(/[+/]/);
    expect(musicSecretSchema.safeParse(secret).success).toBe(true);
    expect(musicSecretSchema.safeParse(varied).success).toBe(true);
    for (const bad of [
      base64Of(repeated(31)),
      base64Of(repeated(33)),
      secret.replace(/=$/, ""),
      secret.slice(0, 42) + "B=",
      varied.replace(/\+/g, "-").replace(/\//g, "_"),
      ` ${secret}`,
    ]) {
      expect(musicSecretSchema.safeParse(bad).success).toBe(false);
    }
  });

  it("never lets the theme schema carry a secret value", () => {
    expect(
      appThemeSchema.safeParse({ ...defaultAppTheme, musicSecret: secret })
        .success,
    ).toBe(false);
  });

  it("scopes music mode to Dorcas", () => {
    expect(MUSIC_MODE_THEME_ID).toBe("dorcas");
  });
});
