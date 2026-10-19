import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  collectLogLines,
  collectLogPayloads,
  getHelpOutput,
  runCommand,
  setupCommandOutputTestEnvironment,
  stubServerApi,
  type CommandRegistrar,
} from "../helpers/command-output-harness.js";
import { registerThemeCommands } from "../../commands/theme.js";

describe("bb theme commands", () => {
  setupCommandOutputTestEnvironment();

  const register: CommandRegistrar = (program) =>
    registerThemeCommands(program, () => "http://server");

  const SECRET = Buffer.alloc(32, 0x42).toString("base64");
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "bb-cli-theme-"));
    vi.stubEnv("BB_DATA_DIR", join(workDir, "data"));
    vi.stubEnv("BB_CLI_ERROR_LOG", "1");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(workDir, { recursive: true, force: true });
  });

  function writeSecretFile(contents: string): string {
    const path = join(workDir, "pairing-secret");
    writeFileSync(path, contents, "utf8");
    return path;
  }

  function allOutput(): string {
    return [
      ...collectLogLines(vi.mocked(console.log)),
      ...collectLogLines(vi.mocked(console.error)),
    ].join("\n");
  }

  function errorLog(): string {
    try {
      return readFileSync(
        join(workDir, "data", "logs", "cli-errors.jsonl"),
        "utf8",
      );
    } catch {
      return "";
    }
  }

  function stubAppearance(
    themeId = "dracula",
    faviconColor = "purple",
    music: {
      musicMode?: boolean;
      musicPort?: number;
      musicSecret?: "set" | null;
    } = {},
  ) {
    const stored = {
      musicMode: false,
      musicPort: 47_615,
      musicSecret: null,
      ...music,
    };
    const put = vi.fn(async ({ json }) => ({
      ...json,
      musicSecret: stored.musicSecret,
      customCss: null,
      resolvedCodeTheme: {
        dark: "pierre-dark",
        light: "pierre-light",
        files: {},
      },
    }));
    const secretPut = vi.fn(async ({ json }) => ({
      themeId,
      faviconColor,
      musicMode: stored.musicMode,
      musicPort: stored.musicPort,
      musicSecret: json.secret === null ? null : "set",
      customCss: null,
      resolvedCodeTheme: {
        dark: "pierre-dark",
        light: "pierre-light",
        files: {},
      },
    }));
    stubServerApi({
      "v1.system.config.$get": vi.fn(async () => ({
        appearance: {
          themeId,
          faviconColor,
          ...stored,
          customCss: null,
          resolvedCodeTheme: {
            dark: "pierre-dark",
            light: "pierre-light",
            files: {},
          },
        },
      })),
      "v1.settings.appearance.$put": put,
      "v1.settings.appearance.music-secret.$put": secretPut,
    });
    return Object.assign(put, { secretPut });
  }

  it("preserves the favicon color for a theme-only update", async () => {
    const put = stubAppearance();

    await runCommand(["theme", "set", "nord"], register);

    expect(put).toHaveBeenCalledWith({
      json: {
        themeId: "nord",
        faviconColor: "purple",
        musicMode: false,
        musicPort: 47_615,
      },
    });
  });

  it("sends and prints a complete selection update as JSON", async () => {
    const put = stubAppearance();

    await runCommand(
      ["theme", "set", "nord", "--favicon-color", "teal", "--json"],
      register,
    );

    expect(put).toHaveBeenCalledWith({
      json: {
        themeId: "nord",
        faviconColor: "teal",
        musicMode: false,
        musicPort: 47_615,
      },
    });
    expect(collectLogPayloads(vi.mocked(console.log))).toEqual([
      JSON.stringify(
        {
          themeId: "nord",
          faviconColor: "teal",
          musicMode: false,
          musicPort: 47_615,
          musicSecret: null,
          customCss: null,
          resolvedCodeTheme: {
            dark: "pierre-dark",
            light: "pierre-light",
            files: {},
          },
        },
        null,
        2,
      ),
    ]);
  });

  it("sets and resets the favicon color without changing the theme", async () => {
    const put = stubAppearance("plugin:palette:ocean", "purple", {
      musicMode: true,
      musicPort: 50_000,
      musicSecret: "set",
    });

    await runCommand(["theme", "favicon", "set", "blue"], register);
    await runCommand(["theme", "favicon", "reset"], register);

    const music = { musicMode: true, musicPort: 50_000 };
    expect(put).toHaveBeenNthCalledWith(1, {
      json: { themeId: "plugin:palette:ocean", faviconColor: "blue", ...music },
    });
    expect(put).toHaveBeenNthCalledWith(2, {
      json: {
        themeId: "plugin:palette:ocean",
        faviconColor: "default",
        ...music,
      },
    });
    expect(put.secretPut).not.toHaveBeenCalled();
  });

  it("resets the theme to Thecla without resetting the favicon color", async () => {
    const put = stubAppearance("nord", "pink");

    await runCommand(["theme", "reset"], register);

    expect(put).toHaveBeenCalledWith({
      json: {
        themeId: "thecla",
        faviconColor: "pink",
        musicMode: false,
        musicPort: 47_615,
      },
    });
  });

  it("rejects invalid favicon colors before writing", async () => {
    const put = stubAppearance();

    await expect(
      runCommand(["theme", "favicon", "set", "chartreuse"], register),
    ).rejects.toThrow("process.exit:1");
    await expect(
      runCommand(
        ["theme", "set", "nord", "--favicon-color", "chartreuse"],
        register,
      ),
    ).rejects.toThrow("process.exit:1");

    expect(put).not.toHaveBeenCalled();
    expect(collectLogLines(vi.mocked(console.error)).join("\n")).toContain(
      "Invalid favicon color 'chartreuse'",
    );
  });

  it("turns music mode on with a port and keeps the stored favicon", async () => {
    const put = stubAppearance("nord", "pink");

    await runCommand(
      ["theme", "set", "dorcas", "--music", "on", "--music-port", "50123"],
      register,
    );

    expect(put).toHaveBeenCalledWith({
      json: {
        themeId: "dorcas",
        faviconColor: "pink",
        musicMode: true,
        musicPort: 50_123,
      },
    });
    expect(collectLogLines(vi.mocked(console.log))).toEqual([
      "Theme set to Dorcas (dorcas)",
      "Music mode: on",
      "Music port: 50123",
      "Music secret: not set",
    ]);
  });

  it("keeps music mode when only the theme changes", async () => {
    const put = stubAppearance("dorcas", "default", {
      musicMode: true,
      musicPort: 50_000,
      musicSecret: "set",
    });

    await runCommand(["theme", "set", "nord"], register);

    expect(put).toHaveBeenCalledWith({
      json: {
        themeId: "nord",
        faviconColor: "default",
        musicMode: true,
        musicPort: 50_000,
      },
    });
  });

  it("stores the secret from a file without printing it", async () => {
    const put = stubAppearance("dorcas", "default");
    const path = writeSecretFile(`${SECRET}\n`);

    await runCommand(
      ["theme", "set", "dorcas", "--music-secret-file", path],
      register,
    );
    await runCommand(
      ["theme", "set", "dorcas", "--music-secret-file", path, "--json"],
      register,
    );

    expect(put.secretPut).toHaveBeenNthCalledWith(1, {
      json: { secret: SECRET },
    });
    expect(put.secretPut).toHaveBeenCalledTimes(2);
    expect(allOutput()).toContain("Music secret: set");
    expect(allOutput()).toContain('"musicSecret": "set"');
    expect(allOutput()).not.toContain(SECRET);
  });

  it("clears the secret", async () => {
    const put = stubAppearance("dorcas", "default", { musicSecret: "set" });

    await runCommand(
      ["theme", "set", "dorcas", "--music-secret-clear"],
      register,
    );

    expect(put.secretPut).toHaveBeenCalledWith({ json: { secret: null } });
    expect(collectLogLines(vi.mocked(console.log))).toContain(
      "Music secret: not set",
    );
  });

  it("rejects a malformed secret file without echoing its contents or writing", async () => {
    const put = stubAppearance();
    const malformed = `${SECRET.slice(0, 40)}#!`;
    const path = writeSecretFile(malformed);

    for (const extra of [[], ["--json"]]) {
      await expect(
        runCommand(
          ["theme", "set", "dorcas", "--music-secret-file", path, ...extra],
          register,
        ),
      ).rejects.toThrow("process.exit:1");
    }

    expect(put).not.toHaveBeenCalled();
    expect(put.secretPut).not.toHaveBeenCalled();
    expect(allOutput()).toContain("does not hold a valid pairing secret");
    expect(allOutput()).not.toContain(malformed);
    expect(allOutput()).not.toContain(SECRET.slice(0, 40));
    expect(errorLog()).toContain('"command":"theme set"');
    expect(errorLog()).not.toContain(SECRET.slice(0, 40));
  });

  it("rejects conflicting secret flags and invalid music values before writing", async () => {
    const put = stubAppearance();
    const path = writeSecretFile(SECRET);

    for (const args of [
      ["--music-secret-file", path, "--music-secret-clear"],
      ["--music", "loud"],
      ["--music-port", "1023"],
      ["--music-port", "65536"],
      ["--music-port", "4e4"],
    ]) {
      await expect(
        runCommand(["theme", "set", "dorcas", ...args], register),
      ).rejects.toThrow("process.exit:1");
    }

    expect(put).not.toHaveBeenCalled();
    expect(put.secretPut).not.toHaveBeenCalled();
    expect(allOutput()).not.toContain(SECRET);
  });

  it("shows the music preferences and says other themes ignore them", async () => {
    stubAppearance("nord", "default", { musicMode: true, musicSecret: "set" });

    await runCommand(["theme", "show"], register);

    expect(collectLogLines(vi.mocked(console.log))).toEqual([
      "Active: Nord (nord)",
      "Favicon color: default",
      "Code theme: pierre-dark / pierre-light",
      "Music mode: on (no effect: music mode only affects the Dorcas theme)",
      "Music port: 47615",
      "Music secret: set",
    ]);
  });

  it("prints the secret status, never a value, in show and list JSON", async () => {
    stubAppearance("dorcas", "default", {
      musicMode: true,
      musicSecret: "set",
    });
    stubServerApi({
      "v1.system.config.$get": vi.fn(async () => ({
        appearance: {
          themeId: "dorcas",
          faviconColor: "default",
          musicMode: true,
          musicPort: 47_615,
          musicSecret: "set",
          customCss: null,
          resolvedCodeTheme: { dark: "a", light: "a", files: {} },
        },
      })),
      "v1.settings.themes.$get": vi.fn(async () => ({
        dir: "/themes",
        custom: [],
        plugins: [],
        active: {
          themeId: "dorcas",
          faviconColor: "default",
          musicMode: true,
          musicPort: 47_615,
          musicSecret: "set",
          customCss: null,
          resolvedCodeTheme: { dark: "a", light: "a", files: {} },
        },
      })),
    });

    await runCommand(["theme", "show", "--json"], register);
    await runCommand(["theme", "list", "--json"], register);

    const payloads = collectLogPayloads(vi.mocked(console.log)).map((payload) =>
      JSON.parse(payload),
    );
    expect(payloads[0]).toMatchObject({ musicMode: true, musicSecret: "set" });
    expect(payloads[1].active).toMatchObject({
      musicMode: true,
      musicPort: 47_615,
      musicSecret: "set",
    });
  });

  it("documents the music flags in help", async () => {
    const help = await getHelpOutput(["theme", "set"], register);

    expect(help).toContain("--music <on|off>");
    expect(help).toContain("--music-port <n>");
    expect(help).toContain("--music-secret-file <path>");
    expect(help).toContain("--music-secret-clear");
    expect(help.replace(/\s+/g, " ")).toContain(
      "it only affects the Dorcas theme",
    );
  });

  it("does not list a code-theme command in help", async () => {
    const themeHelp = await getHelpOutput(["theme"], register);

    expect(themeHelp).not.toContain("code-theme");
  });
});
