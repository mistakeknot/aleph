import { readFile } from "node:fs/promises";
import { Command } from "commander";
import {
  builtInThemes,
  defaultFaviconColor,
  faviconColorPreferenceSchema,
  FAVICON_COLORS,
  isBuiltInThemeId,
  MUSIC_MODE_THEME_ID,
  MUSIC_PORT_MAX,
  MUSIC_PORT_MIN,
  musicPortSchema,
  musicSecretSchema,
  NEW_INSTALL_DEFAULT_THEME_ID,
  themeSelectionFrom,
  type AppTheme,
  type FaviconColorPreference,
} from "@bb/domain";
import { action, CliUsageError } from "../action.js";
import { createCliBbSdk } from "../client.js";
import { outputJson, type JsonOutputOptions } from "./helpers.js";

interface ThemeShowCommandOptions extends JsonOutputOptions {
  css?: boolean;
}

interface ThemeSetCommandOptions extends JsonOutputOptions {
  faviconColor?: string;
  music?: string;
  musicPort?: string;
  musicSecretFile?: string;
  musicSecretClear?: boolean;
}

type MusicSecretChange =
  | { kind: "keep" }
  | { kind: "set"; secret: string }
  | { kind: "clear" };

function parseFaviconColor(value: string): FaviconColorPreference {
  const parsed = faviconColorPreferenceSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      `Invalid favicon color '${value}'. Expected one of: default, ${FAVICON_COLORS.join(
        ", ",
      )}.`,
    );
  }
  return parsed.data;
}

function parseMusicMode(value: string): boolean {
  if (value === "on") return true;
  if (value === "off") return false;
  throw new CliUsageError({
    code: "invalid_value",
    hint: null,
    message: `Invalid music mode '${value}'. Expected on or off.`,
  });
}

function parseMusicPort(value: string): number {
  const parsed = musicPortSchema.safeParse(
    /^\d+$/.test(value) ? Number(value) : Number.NaN,
  );
  if (!parsed.success) {
    throw new CliUsageError({
      code: "invalid_value",
      hint: null,
      message: `Invalid music port '${value}'. Expected an integer from ${MUSIC_PORT_MIN} to ${MUSIC_PORT_MAX}.`,
    });
  }
  return parsed.data;
}

async function readMusicSecretChange(
  opts: ThemeSetCommandOptions,
): Promise<MusicSecretChange> {
  if (opts.musicSecretFile !== undefined && opts.musicSecretClear) {
    throw new CliUsageError({
      code: "invalid_value",
      hint: null,
      message: "Use either --music-secret-file or --music-secret-clear.",
    });
  }
  if (opts.musicSecretClear) return { kind: "clear" };
  if (opts.musicSecretFile === undefined) return { kind: "keep" };
  let contents: string;
  try {
    contents = await readFile(opts.musicSecretFile, "utf8");
  } catch {
    throw new CliUsageError({
      code: "invalid_value",
      hint: null,
      message: `Cannot read the music secret file '${opts.musicSecretFile}'.`,
    });
  }
  const parsed = musicSecretSchema.safeParse(contents.trim());
  if (!parsed.success) {
    throw new CliUsageError({
      code: "invalid_value",
      hint: "Phosphene writes the pairing secret as 32 bytes in standard base64.",
      message: `The music secret file '${opts.musicSecretFile}' does not hold a valid pairing secret.`,
    });
  }
  return { kind: "set", secret: parsed.data };
}

function hasSelectionOverrides(opts: ThemeSetCommandOptions): boolean {
  return (
    opts.faviconColor !== undefined ||
    opts.music !== undefined ||
    opts.musicPort !== undefined
  );
}

function describeMusicMode(theme: AppTheme): string {
  const state = theme.musicMode ? "on" : "off";
  if (theme.themeId === MUSIC_MODE_THEME_ID) return state;
  return `${state} (no effect: music mode only affects the Dorcas theme)`;
}

function printMusicPreferences(theme: AppTheme): void {
  console.log(`Music mode: ${describeMusicMode(theme)}`);
  console.log(`Music port: ${theme.musicPort}`);
  console.log(`Music secret: ${theme.musicSecret ?? "not set"}`);
}

function describeTheme(theme: AppTheme): string {
  if (!isBuiltInThemeId(theme.themeId)) {
    const bytes = theme.customCss?.length ?? 0;
    return `Custom theme '${theme.themeId}' (${bytes} bytes)`;
  }
  const meta = builtInThemes.find((entry) => entry.id === theme.themeId);
  return meta ? `${meta.name} (${meta.id})` : theme.themeId;
}

function describeCodeTheme(theme: AppTheme): string {
  const { dark, light } = theme.resolvedCodeTheme;
  return dark === light ? dark : `${dark} / ${light}`;
}

export function registerThemeCommands(
  program: Command,
  getUrl: () => string,
): void {
  const theme = program
    .command("theme")
    .description("Manage the app theme, favicon color and Dorcas music mode");

  theme
    .command("list")
    .description("List built-in and custom themes and the active palette")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (opts: JsonOutputOptions) => {
        const sdk = createCliBbSdk(getUrl());
        const catalog = await sdk.theme.catalog();
        if (
          outputJson(opts, {
            active: catalog.active,
            builtInThemes,
            custom: catalog.custom,
            plugins: catalog.plugins,
            dir: catalog.dir,
          })
        ) {
          return;
        }
        const active = catalog.active.themeId;
        console.log("");
        console.log("Built-in:");
        for (const entry of builtInThemes) {
          const marker = active === entry.id ? "*" : " ";
          console.log(`${marker} ${entry.id.padEnd(12)} ${entry.description}`);
        }
        console.log("");
        console.log(`Custom (${catalog.dir}):`);
        if (catalog.custom.length === 0) {
          console.log(
            `  (none — create <name>/theme.css under that directory)`,
          );
        } else {
          for (const name of catalog.custom) {
            const marker = active === name ? "*" : " ";
            console.log(`${marker} ${name}`);
          }
        }
        console.log("");
        console.log("Plugins:");
        if (catalog.plugins.length === 0) console.log("  (none)");
        for (const entry of catalog.plugins) {
          const marker = active === entry.id ? "*" : " ";
          console.log(`${marker} ${entry.id.padEnd(24)} ${entry.name}`);
        }
        console.log("");
        console.log(`Active: ${describeTheme(catalog.active)}`);
        console.log(`Favicon color: ${catalog.active.faviconColor}`);
        console.log(`Code theme: ${describeCodeTheme(catalog.active)}`);
        printMusicPreferences(catalog.active);
      }),
    );

  theme
    .command("set <id>")
    .description(
      "Switch to a built-in, custom, or plugin-contributed theme by id",
    )
    .option(
      "--favicon-color <color>",
      "Set the favicon color in the same appearance update",
    )
    .option(
      "--music <on|off>",
      "Turn music mode on or off (it only affects the Dorcas theme)",
    )
    .option(
      "--music-port <n>",
      `Set the loopback port of the Phosphene signal server (${MUSIC_PORT_MIN}-${MUSIC_PORT_MAX})`,
    )
    .option(
      "--music-secret-file <path>",
      "Read the Phosphene pairing secret from a file and store it",
    )
    .option("--music-secret-clear", "Remove the stored pairing secret")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (id: string, opts: ThemeSetCommandOptions) => {
        const faviconColor =
          opts.faviconColor === undefined
            ? undefined
            : parseFaviconColor(opts.faviconColor);
        const musicMode =
          opts.music === undefined ? undefined : parseMusicMode(opts.music);
        const musicPort =
          opts.musicPort === undefined
            ? undefined
            : parseMusicPort(opts.musicPort);
        const secretChange = await readMusicSecretChange(opts);
        const sdk = createCliBbSdk(getUrl());
        let updated: AppTheme;
        if (hasSelectionOverrides(opts)) {
          const current = themeSelectionFrom(await sdk.theme.get(), id);
          updated = await sdk.theme.set({
            themeId: id,
            faviconColor: faviconColor ?? current.faviconColor,
            musicMode: musicMode ?? current.musicMode,
            musicPort: musicPort ?? current.musicPort,
          });
        } else {
          updated = await sdk.theme.set(id);
        }
        if (secretChange.kind !== "keep") {
          updated = await sdk.theme.setMusicSecret({
            secret: secretChange.kind === "set" ? secretChange.secret : null,
          });
        }
        if (outputJson(opts, updated)) return;
        console.log(`Theme set to ${describeTheme(updated)}`);
        if (
          musicMode !== undefined ||
          musicPort !== undefined ||
          secretChange.kind !== "keep"
        ) {
          printMusicPreferences(updated);
        }
      }),
    );

  theme
    .command("dir")
    .description("Print the directory where custom themes live")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (opts: JsonOutputOptions) => {
        const sdk = createCliBbSdk(getUrl());
        const catalog = await sdk.theme.catalog();
        if (outputJson(opts, { dir: catalog.dir })) return;
        console.log(catalog.dir);
      }),
    );

  const favicon = theme
    .command("favicon")
    .description("Manage the app favicon color without changing the theme");

  favicon
    .command("set <color>")
    .description(
      `Set the favicon color (${FAVICON_COLORS.join(", ")}, or default)`,
    )
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (color: string, opts: JsonOutputOptions) => {
        const sdk = createCliBbSdk(getUrl());
        const active = await sdk.theme.get();
        const updated = await sdk.theme.set({
          ...themeSelectionFrom(active),
          faviconColor: parseFaviconColor(color),
        });
        if (outputJson(opts, updated)) return;
        console.log(`Favicon color set to ${updated.faviconColor}`);
      }),
    );

  favicon
    .command("reset")
    .description("Reset the favicon color without changing the theme")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (opts: JsonOutputOptions) => {
        const sdk = createCliBbSdk(getUrl());
        const active = await sdk.theme.get();
        const updated = await sdk.theme.set({
          ...themeSelectionFrom(active),
          faviconColor: defaultFaviconColor,
        });
        if (outputJson(opts, updated)) return;
        console.log(`Favicon color reset to ${updated.faviconColor}`);
      }),
    );

  theme
    .command("show [id]")
    .description(
      "Show the active theme, or resolve a theme by id without activating it",
    )
    .option("--css", "Print the theme's CSS (custom and plugin themes only)")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (id: string | undefined, opts: ThemeShowCommandOptions) => {
        const sdk = createCliBbSdk(getUrl());
        const theme =
          id === undefined
            ? await sdk.theme.get()
            : await sdk.theme.resolve({ themeId: id });
        if (outputJson(opts, theme)) return;
        if (opts.css) {
          if (theme.customCss !== null) {
            console.log(theme.customCss);
          } else {
            console.log(
              "// Built-in theme CSS is bundled in the app, not stored on disk.",
            );
          }
          return;
        }
        if (id === undefined) {
          console.log(`Active: ${describeTheme(theme)}`);
          console.log(`Favicon color: ${theme.faviconColor}`);
        } else {
          console.log(`Theme: ${describeTheme(theme)}`);
        }
        console.log(`Code theme: ${describeCodeTheme(theme)}`);
        printMusicPreferences(theme);
      }),
    );

  theme
    .command("reset")
    .description("Reset to the Thecla theme")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (opts: JsonOutputOptions) => {
        const sdk = createCliBbSdk(getUrl());
        const updated = await sdk.theme.set(NEW_INSTALL_DEFAULT_THEME_ID);
        if (outputJson(opts, updated)) return;
        console.log(`Theme reset to ${describeTheme(updated)}`);
      }),
    );
}
