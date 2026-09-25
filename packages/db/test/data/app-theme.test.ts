import { describe, expect, it } from "vitest";
import { NEW_INSTALL_DEFAULT_THEME_ID } from "@bb/domain";
import {
  createConnection,
  getStoredFaviconColor,
  getStoredThemeId,
  migrate,
  setStoredAppearance,
} from "../../src/index.js";

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

    setStoredAppearance(db, { themeId: "default", faviconColor: "default" });

    expect(getStoredThemeId(db)).toBe("default");
  });

  it("keeps any other explicitly chosen theme", () => {
    const db = createConnection(":memory:");
    migrate(db);

    setStoredAppearance(db, { themeId: "nord", faviconColor: "blue" });

    expect(getStoredThemeId(db)).toBe("nord");
    expect(getStoredFaviconColor(db)).toBe("blue");
  });
});
