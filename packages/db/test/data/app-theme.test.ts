import { describe, expect, it } from "vitest";
import { NEW_INSTALL_DEFAULT_THEME_ID } from "@bb/domain";
import {
  createConnection,
  getStoredFaviconColor,
  getStoredMusicPairing,
  getStoredMusicPreferences,
  getStoredThemeId,
  migrate,
  setStoredAppearance,
  setStoredMusicSecret,
} from "../../src/index.js";

const music = { musicMode: false, musicPort: 47_615 };
const secret = Buffer.alloc(32, 9).toString("base64");

describe("app theme storage", () => {
  it("defaults a fresh install (no stored row) to the new-install theme", () => {
    const db = createConnection(":memory:");
    migrate(db);

    expect(getStoredThemeId(db)).toBe(NEW_INSTALL_DEFAULT_THEME_ID);
    expect(getStoredFaviconColor(db)).toBe("default");
  });

  it("keeps an explicit choice of the upstream Default theme", () => {
    const db = createConnection(":memory:");
    migrate(db);

    setStoredAppearance(db, {
      themeId: "default",
      faviconColor: "default",
      ...music,
    });

    expect(getStoredThemeId(db)).toBe("default");
  });

  it("keeps any other explicitly chosen theme", () => {
    const db = createConnection(":memory:");
    migrate(db);

    setStoredAppearance(db, { themeId: "nord", faviconColor: "blue", ...music });

    expect(getStoredThemeId(db)).toBe("nord");
    expect(getStoredFaviconColor(db)).toBe("blue");
  });

  it("defaults music preferences on a fresh install", () => {
    const db = createConnection(":memory:");
    migrate(db);

    expect(getStoredMusicPreferences(db)).toEqual({
      musicMode: false,
      musicPort: 47_615,
      musicSecretSet: false,
    });
    expect(getStoredMusicPairing(db)).toEqual({ port: 47_615, secret: null });
  });

  it("stores the secret apart from the selection so theme writes keep it", () => {
    const db = createConnection(":memory:");
    migrate(db);

    setStoredMusicSecret(db, secret);
    expect(getStoredThemeId(db)).toBe(NEW_INSTALL_DEFAULT_THEME_ID);
    setStoredAppearance(db, {
      themeId: "dorcas",
      faviconColor: "teal",
      musicMode: true,
      musicPort: 50_000,
    });
    setStoredAppearance(db, {
      themeId: "nord",
      faviconColor: "pink",
      musicMode: true,
      musicPort: 50_000,
    });

    expect(getStoredMusicPreferences(db)).toEqual({
      musicMode: true,
      musicPort: 50_000,
      musicSecretSet: true,
    });
    expect(getStoredMusicPairing(db)).toEqual({ port: 50_000, secret });

    setStoredMusicSecret(db, null);
    expect(getStoredMusicPairing(db)).toEqual({ port: 50_000, secret: null });
    expect(getStoredMusicPreferences(db).musicSecretSet).toBe(false);
    expect(getStoredThemeId(db)).toBe("nord");
    expect(getStoredFaviconColor(db)).toBe("pink");
  });
});
