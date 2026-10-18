import { z } from "zod";
import {
  defaultResolvedCodeTheme,
  resolvedCodeThemeSchema,
} from "./code-theme.js";

const builtInThemeIdSchema = z.enum([
  "default",
  "nord",
  "dracula",
  "solarized",
  "gruvbox",
  "catppuccin",
  "thecla",
  "dorcas",
]);
export type BuiltInThemeId = z.infer<typeof builtInThemeIdSchema>;

interface BuiltInThemeMeta {
  id: BuiltInThemeId;
  name: string;
  description: string;
}

export const builtInThemes: readonly BuiltInThemeMeta[] = [
  { id: "default", name: "Default", description: "The standard bb look" },
  { id: "nord", name: "Nord", description: "Cool, muted arctic blues" },
  {
    id: "dracula",
    name: "Dracula",
    description: "Dark, high-contrast purple and pink",
  },
  {
    id: "solarized",
    name: "Solarized",
    description: "Balanced light and dark (Schoonover palette)",
  },
  { id: "gruvbox", name: "Gruvbox", description: "Warm retro earth tones" },
  {
    id: "catppuccin",
    name: "Catppuccin",
    description: "Soothing pastel — Latte light, Mocha dark",
  },
  {
    id: "thecla",
    name: "Thecla",
    description: "Luminous rose, orchid pink, and cyan on deep black",
  },
  {
    id: "dorcas",
    name: "Dorcas",
    description:
      "Thecla dimmed for OLED: quiet lines drifting rose to cyan on true black",
  },
];

export const BUILTIN_THEME_IDS = builtInThemeIdSchema.options;

export function isBuiltInThemeId(id: string): id is BuiltInThemeId {
  return (BUILTIN_THEME_IDS as readonly string[]).includes(id);
}

export const customThemeNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(
    /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/,
    "Custom theme names may use letters, digits, '.', '_', and '-' and cannot start with '.'",
  )
  .refine((name) => name !== "." && name !== "..", "Invalid custom theme name")
  .refine(
    (name) => !isBuiltInThemeId(name),
    "Custom theme name collides with a built-in palette id",
  );

export const CUSTOM_THEME_CSS_MAX_LENGTH = 256_000;

export const FAVICON_COLORS = [
  "red",
  "orange",
  "yellow",
  "green",
  "teal",
  "blue",
  "purple",
  "pink",
] as const;
export type FaviconColor = (typeof FAVICON_COLORS)[number];

export const faviconColorPreferenceSchema = z.enum([
  "default",
  ...FAVICON_COLORS,
]);
export type FaviconColorPreference = z.infer<
  typeof faviconColorPreferenceSchema
>;

export const defaultFaviconColor: FaviconColorPreference = "default";

export const MUSIC_MODE_THEME_ID: BuiltInThemeId = "dorcas";
export const MUSIC_PORT_MIN = 1024;
export const MUSIC_PORT_MAX = 65_535;
export const DEFAULT_MUSIC_PORT = 47_615;
export const MUSIC_SECRET_BYTES = 32;

export const musicPortSchema = z
  .number()
  .int()
  .min(MUSIC_PORT_MIN)
  .max(MUSIC_PORT_MAX);

export const musicSecretSchema = z
  .string()
  .regex(
    /^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/,
    "The music pairing secret must be 32 bytes in standard base64",
  );

export const musicSecretStatusSchema = z.literal("set").nullable();
export type MusicSecretStatus = z.infer<typeof musicSecretStatusSchema>;

export const appThemeSchema = z.object({
  themeId: z.string().min(1),
  customCss: z.string().max(CUSTOM_THEME_CSS_MAX_LENGTH).nullable(),
  faviconColor: faviconColorPreferenceSchema,
  musicMode: z.boolean().default(false),
  musicPort: musicPortSchema.default(DEFAULT_MUSIC_PORT),
  musicSecret: musicSecretStatusSchema.default(null),
  resolvedCodeTheme: resolvedCodeThemeSchema.default(defaultResolvedCodeTheme),
});
export type AppTheme = z.infer<typeof appThemeSchema>;

export const pluginThemeMetaSchema = z.object({
  id: z.string().min(1),
  pluginId: z.string().min(1),
  name: z.string().min(1),
  description: z.string().nullable(),
});
export type PluginThemeMeta = z.infer<typeof pluginThemeMetaSchema>;

const PLUGIN_THEME_ID_PREFIX = "plugin:";

export function formatPluginThemeId(pluginId: string, themeId: string): string {
  return `${PLUGIN_THEME_ID_PREFIX}${pluginId}:${themeId}`;
}

export const appThemeSelectionSchema = z.object({
  themeId: z.string().min(1),
  faviconColor: faviconColorPreferenceSchema,
  musicMode: z.boolean(),
  musicPort: musicPortSchema,
});
export type AppThemeSelection = z.infer<typeof appThemeSelectionSchema>;

export const musicSecretUpdateSchema = z.object({
  secret: musicSecretSchema.nullable(),
});
export type MusicSecretUpdate = z.infer<typeof musicSecretUpdateSchema>;

export const musicPairingSchema = z.object({
  port: musicPortSchema,
  secret: musicSecretSchema.nullable(),
});
export type MusicPairing = z.infer<typeof musicPairingSchema>;

export const NEW_INSTALL_DEFAULT_THEME_ID: BuiltInThemeId = "thecla";

export const defaultAppTheme: AppTheme = {
  themeId: "default",
  customCss: null,
  faviconColor: defaultFaviconColor,
  musicMode: false,
  musicPort: DEFAULT_MUSIC_PORT,
  musicSecret: null,
  resolvedCodeTheme: defaultResolvedCodeTheme,
};

export function themeSelectionFrom(
  appearance: AppTheme,
  themeId: string = appearance.themeId,
): AppThemeSelection {
  return {
    themeId,
    faviconColor: appearance.faviconColor,
    musicMode: appearance.musicMode,
    musicPort: appearance.musicPort,
  };
}
