import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createConnection,
  getStoredFaviconColor,
  getStoredMusicPairing,
  getStoredThemeId,
} from "@bb/db";
import {
  appThemeSchema,
  type BuiltInThemeId,
  defaultAppTheme,
  formatPluginThemeId,
  resolveCodeTheme,
} from "@bb/domain";

function appearanceForPalette(
  themeId: BuiltInThemeId,
  extras: Partial<typeof defaultAppTheme> = {},
) {
  return {
    ...defaultAppTheme,
    themeId,
    resolvedCodeTheme: resolveCodeTheme(null, themeId),
    ...extras,
  };
}
import {
  themeCatalogResponseSchema,
  systemConfigResponseSchema,
} from "@bb/server-contract";
import { createApp } from "../../src/server.js";
import { readJson } from "../helpers/json.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

const music = { musicMode: false, musicPort: 47_615 };
const SECRET = Buffer.alloc(32, 0x5a).toString("base64");
const OTHER_SECRET = Buffer.alloc(32, 0x33).toString("base64");

function putJson(harness: TestAppHarness, path: string, body: unknown) {
  return harness.app.request(`/api/v1${path}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function activeAppearance(app: TestAppHarness["app"]) {
  return systemConfigResponseSchema.parse(
    await readJson(await app.request("/api/v1/system/config")),
  ).appearance;
}

async function writeCustomTheme(
  dataDir: string,
  name: string,
  css: string,
): Promise<void> {
  const dir = join(dataDir, "theme", name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "theme.css"), css, "utf8");
}

describe("appearance settings", () => {
  it("defaults appearance to the Thecla palette in /system/config", async () => {
    await withTestHarness(async (harness) => {
      const response = await harness.app.request("/api/v1/system/config");
      expect(response.status).toBe(200);
      const body = systemConfigResponseSchema.parse(await readJson(response));
      expect(body.appearance).toEqual(appearanceForPalette("thecla"));
      expect(body.customThemes).toEqual([]);
      expect(body.pluginThemes).toEqual([]);
    });
  });

  it("persists a built-in theme and reflects it in /system/config", async () => {
    await withTestHarness(async (harness) => {
      const put = await harness.app.request("/api/v1/settings/appearance", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          themeId: "nord",
          faviconColor: "default",
          ...music,
        }),
      });
      expect(put.status).toBe(200);
      expect(appThemeSchema.parse(await readJson(put))).toEqual(
        appearanceForPalette("nord"),
      );
      expect(getStoredThemeId(harness.db)).toBe("nord");

      const config = await harness.app.request("/api/v1/system/config");
      expect(
        systemConfigResponseSchema.parse(await readJson(config)).appearance,
      ).toEqual(appearanceForPalette("nord"));
    });
  });

  it("activates a custom theme discovered on disk", async () => {
    await withTestHarness(async (harness) => {
      const css = ":root { --primary: #ff00ff; }";
      await writeCustomTheme(harness.config.dataDir, "midnight", css);

      const put = await harness.app.request("/api/v1/settings/appearance", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          themeId: "midnight",
          faviconColor: "teal",
          ...music,
        }),
      });
      expect(put.status).toBe(200);
      expect(appThemeSchema.parse(await readJson(put))).toEqual({
        ...defaultAppTheme,
        themeId: "midnight",
        customCss: css,
        faviconColor: "teal",
      });
      expect(getStoredThemeId(harness.db)).toBe("midnight");

      const config = systemConfigResponseSchema.parse(
        await readJson(await harness.app.request("/api/v1/system/config")),
      );
      expect(config.appearance).toEqual({
        ...defaultAppTheme,
        themeId: "midnight",
        customCss: css,
        faviconColor: "teal",
      });
      expect(config.customThemes).toEqual(["midnight"]);
    });
  });

  it("persists the favicon color independently of the palette", async () => {
    await withTestHarness(async (harness) => {
      const put = await harness.app.request("/api/v1/settings/appearance", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          themeId: "default",
          faviconColor: "teal",
          ...music,
        }),
      });
      expect(put.status).toBe(200);
      expect(getStoredFaviconColor(harness.db)).toBe("teal");

      const config = systemConfigResponseSchema.parse(
        await readJson(await harness.app.request("/api/v1/system/config")),
      );
      expect(config.appearance).toEqual({
        ...defaultAppTheme,
        faviconColor: "teal",
      });
    });
  });

  it("persists a complete selection when changing the theme", async () => {
    await withTestHarness(async (harness) => {
      await harness.app.request("/api/v1/settings/appearance", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          themeId: "default",
          faviconColor: "purple",
          ...music,
        }),
      });

      const put = await harness.app.request("/api/v1/settings/appearance", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          themeId: "nord",
          faviconColor: "purple",
          ...music,
        }),
      });
      expect(appThemeSchema.parse(await readJson(put))).toEqual(
        appearanceForPalette("nord", { faviconColor: "purple" }),
      );
      expect(getStoredFaviconColor(harness.db)).toBe("purple");
    });
  });

  it("rejects an unknown favicon color", async () => {
    await withTestHarness(async (harness) => {
      const response = await harness.app.request(
        "/api/v1/settings/appearance",
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            themeId: "default",
            faviconColor: "chartreuse",
            ...music,
          }),
        },
      );
      expect(response.status).toBe(400);
    });
  });

  it("rejects an incomplete appearance selection", async () => {
    await withTestHarness(async (harness) => {
      const response = await harness.app.request(
        "/api/v1/settings/appearance",
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ themeId: "nord" }),
        },
      );
      expect(response.status).toBe(400);
    });
  });

  it("lists discovered custom themes in the theme catalog", async () => {
    await withTestHarness(async (harness) => {
      await writeCustomTheme(harness.config.dataDir, "zephyr", ":root {}");
      await writeCustomTheme(harness.config.dataDir, "amber", ":root {}");
      await mkdir(join(harness.config.dataDir, "theme", "incomplete"), {
        recursive: true,
      });

      const response = await harness.app.request("/api/v1/settings/themes");
      expect(response.status).toBe(200);
      const catalog = themeCatalogResponseSchema.parse(
        await readJson(response),
      );
      expect(catalog.dir).toBe(join(harness.config.dataDir, "theme"));
      expect(catalog.custom).toEqual(["amber", "zephyr"]);
      expect(catalog.plugins).toEqual([]);
      expect(catalog.active).toEqual(appearanceForPalette("thecla"));
    });
  });

  it("lists and activates palettes shipped by loaded plugins", async () => {
    await withTestHarness(async (harness) => {
      const root = join(
        harness.config.dataDir,
        "fixtures",
        "bb-plugin-palette",
      );
      await mkdir(join(root, "themes"), { recursive: true });
      await writeFile(
        join(root, "package.json"),
        JSON.stringify({
          name: "bb-plugin-palette",
          version: "0.1.0",
          bb: {
            name: "Palette fixture",
            description: "Plugin palette fixture.",
            branding: { icon: "Zap" },
            server: "./server.ts",
            themes: [
              {
                id: "ocean",
                name: "Ocean",
                description: "Deep blue",
                css: "./themes/ocean.css",
              },
            ],
          },
        }),
      );
      await writeFile(
        join(root, "server.ts"),
        "export default function () {}\n",
      );
      await writeFile(
        join(root, "themes", "ocean.css"),
        ":root { --canvas: blue; }",
      );
      await harness.pluginService.installPath(root);

      const themeId = formatPluginThemeId("palette", "ocean");
      const catalogResponse = await harness.app.request(
        "/api/v1/settings/themes",
      );
      const catalog = themeCatalogResponseSchema.parse(
        await readJson(catalogResponse),
      );
      expect(catalog.plugins).toEqual([
        {
          id: themeId,
          pluginId: "palette",
          name: "Ocean",
          description: "Deep blue",
        },
      ]);

      const response = await harness.app.request(
        "/api/v1/settings/appearance",
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ themeId, faviconColor: "default", ...music }),
        },
      );
      expect(response.status).toBe(200);
      expect(appThemeSchema.parse(await readJson(response))).toEqual({
        ...defaultAppTheme,
        themeId,
        customCss: ":root { --canvas: blue; }",
      });
    });
  });

  it("falls back to default when the active custom theme is deleted", async () => {
    await withTestHarness(async (harness) => {
      await writeCustomTheme(harness.config.dataDir, "ghost", ":root {}");
      await harness.app.request("/api/v1/settings/appearance", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          themeId: "ghost",
          faviconColor: "default",
          ...music,
        }),
      });

      await rm(join(harness.config.dataDir, "theme", "ghost"), {
        recursive: true,
        force: true,
      });

      const config = systemConfigResponseSchema.parse(
        await readJson(await harness.app.request("/api/v1/system/config")),
      );
      expect(getStoredThemeId(harness.db)).toBe("ghost");
      expect(config.appearance).toEqual(defaultAppTheme);
      expect(config.customThemes).toEqual([]);
    });
  });

  it("rejects selecting a custom theme that does not exist", async () => {
    await withTestHarness(async (harness) => {
      const response = await harness.app.request(
        "/api/v1/settings/appearance",
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            themeId: "nonexistent",
            faviconColor: "default",
            ...music,
          }),
        },
      );
      expect(response.status).toBe(404);
    });
  });

  it("rejects a theme id that is not a safe path segment", async () => {
    await withTestHarness(async (harness) => {
      const response = await harness.app.request(
        "/api/v1/settings/appearance",
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            themeId: "../evil",
            faviconColor: "default",
            ...music,
          }),
        },
      );
      expect(response.status).toBe(400);
    });
  });

  it("lets a custom UI theme ship Pierre code-theme JSON", async () => {
    await withTestHarness(async (harness) => {
      await writeCustomTheme(harness.config.dataDir, "ocean", ":root {}");
      const darkTheme = {
        name: "Ocean Dark",
        type: "dark",
        colors: { "editor.background": "#001" },
        tokenColors: [],
      };
      await writeFile(
        join(harness.config.dataDir, "theme", "ocean", "pierre-dark.json"),
        JSON.stringify(darkTheme),
        "utf8",
      );

      const put = await harness.app.request("/api/v1/settings/appearance", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          themeId: "ocean",
          faviconColor: "default",
          ...music,
        }),
      });
      expect(appThemeSchema.parse(await readJson(put))).toEqual({
        ...defaultAppTheme,
        themeId: "ocean",
        customCss: ":root {}",
        resolvedCodeTheme: {
          dark: "bb:ocean:dark",
          light: "pierre-light",
          files: { "bb:ocean:dark": { ...darkTheme, name: "bb:ocean:dark" } },
        },
      });
    });
  });
});

describe("music mode settings", () => {
  it("stores music mode and port with the selection and reports them everywhere", async () => {
    await withTestHarness(async (harness) => {
      const put = await putJson(harness, "/settings/appearance", {
        themeId: "dorcas",
        faviconColor: "default",
        musicMode: true,
        musicPort: 50_123,
      });
      expect(put.status).toBe(200);
      const expected = appearanceForPalette("dorcas", {
        musicMode: true,
        musicPort: 50_123,
      });
      expect(appThemeSchema.parse(await readJson(put))).toEqual(expected);
      expect(await activeAppearance(harness.app)).toEqual(expected);
      const catalog = themeCatalogResponseSchema.parse(
        await readJson(await harness.app.request("/api/v1/settings/themes")),
      );
      expect(catalog.active).toEqual(expected);
      const preview = appThemeSchema.parse(
        await readJson(
          await harness.app.request("/api/v1/settings/themes/nord"),
        ),
      );
      expect(preview).toMatchObject({
        themeId: "nord",
        musicMode: true,
        musicPort: 50_123,
      });
    });
  });

  it("rejects a privileged or out-of-range music port", async () => {
    await withTestHarness(async (harness) => {
      for (const musicPort of [80, 1023, 65_536, 47_615.5]) {
        const response = await putJson(harness, "/settings/appearance", {
          themeId: "dorcas",
          faviconColor: "default",
          musicMode: true,
          musicPort,
        });
        expect(response.status).toBe(400);
      }
    });
  });

  it("keeps the secret and music preferences across theme and favicon changes and a server restart", async () => {
    await withTestHarness(async (harness) => {
      await putJson(harness, "/settings/appearance", {
        themeId: "dorcas",
        faviconColor: "default",
        musicMode: true,
        musicPort: 50_000,
      });
      const stored = await putJson(
        harness,
        "/settings/appearance/music-secret",
        {
          secret: SECRET,
        },
      );
      expect(stored.status).toBe(200);
      expect(appThemeSchema.parse(await readJson(stored))).toMatchObject({
        themeId: "dorcas",
        musicSecret: "set",
      });

      const themeChange = await putJson(harness, "/settings/appearance", {
        themeId: "nord",
        faviconColor: "default",
        musicMode: true,
        musicPort: 50_000,
      });
      expect(appThemeSchema.parse(await readJson(themeChange))).toMatchObject({
        themeId: "nord",
        musicMode: true,
        musicPort: 50_000,
        musicSecret: "set",
      });

      const faviconChange = await putJson(harness, "/settings/appearance", {
        themeId: "dorcas",
        faviconColor: "teal",
        musicMode: true,
        musicPort: 50_000,
      });
      expect(appThemeSchema.parse(await readJson(faviconChange))).toMatchObject(
        { faviconColor: "teal", musicMode: true, musicSecret: "set" },
      );
      expect(getStoredMusicPairing(harness.db)).toEqual({
        port: 50_000,
        secret: SECRET,
      });

      const restarted = createApp({
        ...harness.deps,
        db: createConnection(harness.db.$client.serialize()),
      });
      try {
        expect(await activeAppearance(restarted.app)).toEqual(
          appearanceForPalette("dorcas", {
            faviconColor: "teal",
            musicMode: true,
            musicPort: 50_000,
            musicSecret: "set",
          }),
        );
        const pairing = await restarted.app.request(
          "/api/v1/settings/appearance/music-pairing",
        );
        expect(await readJson(pairing)).toEqual({
          port: 50_000,
          secret: SECRET,
        });
      } finally {
        await restarted.pluginService.stop();
      }
    });
  });

  it("returns the secret only from the pairing read and clears it", async () => {
    await withTestHarness(async (harness) => {
      await putJson(harness, "/settings/appearance/music-secret", {
        secret: SECRET,
      });
      const pairing = await harness.app.request(
        "/api/v1/settings/appearance/music-pairing",
      );
      expect(pairing.status).toBe(200);
      expect(await readJson(pairing)).toEqual({ port: 47_615, secret: SECRET });

      for (const path of [
        "/api/v1/system/config",
        "/api/v1/settings/themes",
        "/api/v1/settings/themes/dorcas",
      ]) {
        const text = await (await harness.app.request(path)).text();
        expect(text).not.toContain(SECRET);
        expect(text).toContain('"musicSecret":"set"');
      }

      const cleared = await putJson(
        harness,
        "/settings/appearance/music-secret",
        { secret: null },
      );
      expect(appThemeSchema.parse(await readJson(cleared)).musicSecret).toBe(
        null,
      );
      expect(
        await readJson(
          await harness.app.request(
            "/api/v1/settings/appearance/music-pairing",
          ),
        ),
      ).toEqual({ port: 47_615, secret: null });
    });
  });

  it("never echoes a rejected secret or a secret sent with the selection", async () => {
    await withTestHarness(async (harness) => {
      await putJson(harness, "/settings/appearance/music-secret", {
        secret: SECRET,
      });
      const malformed = `${OTHER_SECRET.slice(0, 40)}!!==`;
      for (const secret of [malformed, OTHER_SECRET.slice(0, 43), 7]) {
        const response = await putJson(
          harness,
          "/settings/appearance/music-secret",
          { secret },
        );
        expect(response.status).toBe(400);
        const text = await response.text();
        expect(text).not.toContain(SECRET);
        if (typeof secret === "string") expect(text).not.toContain(secret);
      }

      const smuggled = await putJson(harness, "/settings/appearance", {
        themeId: "dorcas",
        faviconColor: "default",
        musicMode: true,
        musicPort: 47_615,
        musicSecret: OTHER_SECRET,
      });
      expect(smuggled.status).toBe(200);
      expect(await smuggled.text()).not.toContain(OTHER_SECRET);
      expect(getStoredMusicPairing(harness.db).secret).toBe(SECRET);
    });
  });

  it("refuses machine credentials on the secret routes", async () => {
    await withTestHarness(async (harness) => {
      const headers = {
        "content-type": "application/json",
        "x-bb-gate-auth": "machine",
      };
      const write = await harness.app.request(
        "/api/v1/settings/appearance/music-secret",
        { method: "PUT", headers, body: JSON.stringify({ secret: SECRET }) },
      );
      expect(write.status).toBe(403);
      const read = await harness.app.request(
        "/api/v1/settings/appearance/music-pairing",
        { headers },
      );
      expect(read.status).toBe(403);
      expect(getStoredMusicPairing(harness.db).secret).toBe(null);
    });
  });
});
