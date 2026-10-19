import {
  themeSelectionFrom,
  type AppTheme,
  type AppThemeSelection,
  type MusicPairing,
} from "@bb/domain";
import type { ThemeCatalogResponse } from "@bb/server-contract";
import { signalRequestArgs, type CreateSdkAreaArgs } from "./common.js";

export type ThemeGetResult = AppTheme;
export type ThemeCatalogResult = ThemeCatalogResponse;
export type ThemeSetInput = AppThemeSelection;
export type ThemeSetResult = AppTheme;
export type ThemeResolveResult = AppTheme;
export type ThemeSetMusicSecretResult = AppTheme;
export type ThemeMusicPairingResult = MusicPairing;

export interface ThemeCatalogArgs {
  signal?: AbortSignal;
}

export interface ThemeGetArgs {
  signal?: AbortSignal;
}

export interface ThemeResolveArgs {
  themeId: string;
  signal?: AbortSignal;
}

export interface ThemeSetMusicSecretArgs {
  secret: string | null;
  signal?: AbortSignal;
}

export interface ThemeMusicPairingArgs {
  signal?: AbortSignal;
}

export interface ThemeArea {
  get(args?: ThemeGetArgs): Promise<ThemeGetResult>;
  catalog(args?: ThemeCatalogArgs): Promise<ThemeCatalogResult>;
  resolve(args: ThemeResolveArgs): Promise<ThemeResolveResult>;
  set(selection: ThemeSetInput): Promise<ThemeSetResult>;
  set(themeId: string): Promise<ThemeSetResult>;
  setMusicSecret(
    args: ThemeSetMusicSecretArgs,
  ): Promise<ThemeSetMusicSecretResult>;
  musicPairing(args?: ThemeMusicPairingArgs): Promise<ThemeMusicPairingResult>;
}

export function createThemeArea(args: CreateSdkAreaArgs): ThemeArea {
  const { transport } = args;
  return {
    async get(input = {}) {
      const config = await transport.readJson(
        transport.api.v1.system.config.$get(
          {},
          ...signalRequestArgs(input.signal),
        ),
      );
      return config.appearance;
    },
    async catalog(input = {}) {
      return transport.readJson(
        transport.api.v1.settings.themes.$get(
          {},
          ...signalRequestArgs(input.signal),
        ),
      );
    },
    async resolve(input) {
      return transport.readJson(
        transport.api.v1.settings.themes[":id"].$get(
          { param: { id: input.themeId } },
          ...signalRequestArgs(input.signal),
        ),
      );
    },
    async set(input) {
      if (typeof input === "string") {
        const appearance = (
          await transport.readJson(transport.api.v1.system.config.$get())
        ).appearance;
        return transport.readJson(
          transport.api.v1.settings.appearance.$put({
            json: themeSelectionFrom(appearance, input),
          }),
        );
      }
      return transport.readJson(
        transport.api.v1.settings.appearance.$put({ json: input }),
      );
    },
    async setMusicSecret(input) {
      return transport.readJson(
        transport.api.v1.settings.appearance["music-secret"].$put(
          { json: { secret: input.secret } },
          ...signalRequestArgs(input.signal),
        ),
      );
    },
    async musicPairing(input = {}) {
      return transport.readJson(
        transport.api.v1.settings.appearance["music-pairing"].$get(
          {},
          ...signalRequestArgs(input.signal),
        ),
      );
    },
  };
}
