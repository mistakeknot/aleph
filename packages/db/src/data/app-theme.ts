import { eq, sql } from "drizzle-orm";
import {
  DEFAULT_MUSIC_PORT,
  defaultFaviconColor,
  NEW_INSTALL_DEFAULT_THEME_ID,
  type AppThemeSelection,
  type FaviconColorPreference,
  type MusicPairing,
} from "@bb/domain";
import type { DbConnection } from "../connection.js";
import { appTheme } from "../schema.js";

const APP_THEME_ROW_ID = "current";

export function getStoredThemeId(db: DbConnection): string {
  const row = db
    .select({ themeId: appTheme.themeId })
    .from(appTheme)
    .where(eq(appTheme.id, APP_THEME_ROW_ID))
    .get();

  return row?.themeId ?? NEW_INSTALL_DEFAULT_THEME_ID;
}

export function getStoredFaviconColor(
  db: DbConnection,
): FaviconColorPreference {
  const row = db
    .select({ faviconColor: appTheme.faviconColor })
    .from(appTheme)
    .where(eq(appTheme.id, APP_THEME_ROW_ID))
    .get();

  return row?.faviconColor ?? defaultFaviconColor;
}

export interface StoredMusicPreferences {
  musicMode: boolean;
  musicPort: number;
  musicSecretSet: boolean;
}

export function getStoredMusicPreferences(
  db: DbConnection,
): StoredMusicPreferences {
  const row = db
    .select({
      musicMode: appTheme.musicMode,
      musicPort: appTheme.musicPort,
      musicSecretSet: sql<number>`${appTheme.musicSecret} is not null`,
    })
    .from(appTheme)
    .where(eq(appTheme.id, APP_THEME_ROW_ID))
    .get();

  return {
    musicMode: row?.musicMode ?? false,
    musicPort: row?.musicPort ?? DEFAULT_MUSIC_PORT,
    musicSecretSet: row?.musicSecretSet === 1,
  };
}

export function getStoredMusicPairing(db: DbConnection): MusicPairing {
  const row = db
    .select({ port: appTheme.musicPort, secret: appTheme.musicSecret })
    .from(appTheme)
    .where(eq(appTheme.id, APP_THEME_ROW_ID))
    .get();

  return {
    port: row?.port ?? DEFAULT_MUSIC_PORT,
    secret: row?.secret ?? null,
  };
}

export function setStoredAppearance(
  db: DbConnection,
  appearance: AppThemeSelection,
): void {
  const updatedAt = Date.now();
  const { themeId, faviconColor, musicMode, musicPort } = appearance;
  db.insert(appTheme)
    .values({
      id: APP_THEME_ROW_ID,
      themeId,
      faviconColor,
      musicMode,
      musicPort,
      updatedAt,
    })
    .onConflictDoUpdate({
      target: appTheme.id,
      set: { themeId, faviconColor, musicMode, musicPort, updatedAt },
    })
    .run();
}

export function setStoredMusicSecret(
  db: DbConnection,
  secret: string | null,
): void {
  const updatedAt = Date.now();
  db.insert(appTheme)
    .values({
      id: APP_THEME_ROW_ID,
      themeId: NEW_INSTALL_DEFAULT_THEME_ID,
      musicSecret: secret,
      updatedAt,
    })
    .onConflictDoUpdate({
      target: appTheme.id,
      set: { musicSecret: secret, updatedAt },
    })
    .run();
}
