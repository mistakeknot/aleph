import { describe, expect, it } from "vitest";
import { claudeEnvironment, verifyClaudeScrub } from "./claude-env.js";

describe("Claude pool environment", () => {
  const restrictedHelp =
    "--restricted --safe-mode --tools --permission-mode --strict-mcp-config --no-chrome --no-session-persistence --disable-slash-commands";
  it.each([
    ["legacy", "2.1.323", true],
    ["legacy", "2.1.327", true],
    ["restricted", "2.1.325", true],
    ["restricted", "2.1.327", true],
    ["legacy", "2.1.325", false],
    ["legacy", "2.1.326", false],
    ["legacy", "2.1.328", false],
    ["restricted", "2.1.326", false],
    ["restricted", "2.1.328", false],
  ] as const)(
    "qualifies %s exact version %s: %s",
    async (profile, version, accepted) => {
      expect(
        await verifyClaudeScrub(
          {},
          async (command, args) =>
            command === "claude"
              ? args[0] === "--version"
                ? `${version} (Claude Code)`
                : restrictedHelp
              : "",
          "linux",
          profile,
        ),
      ).toBe(accepted);
    },
  );
  it.each(["legacy", "restricted"] as const)(
    "keeps dependency checks for 2.1.327 in %s",
    async (profile) => {
      for (const missing of ["socat", "rg", "bwrap"]) {
        expect(
          await verifyClaudeScrub(
            {},
            async (command, args) => {
              if (command === missing) throw new Error("unavailable");
              return command === "claude"
                ? args[0] === "--version"
                  ? "2.1.327 (Claude Code)"
                  : restrictedHelp
                : "";
            },
            "linux",
            profile,
          ),
        ).toBe(false);
      }
    },
  );
  it.each(restrictedHelp.split(" "))(
    "requires 2.1.327 restricted capability %s",
    async (missing) => {
      expect(
        await verifyClaudeScrub(
          {},
          async (command, args) =>
            command === "claude"
              ? args[0] === "--version"
                ? "2.1.327 (Claude Code)"
                : restrictedHelp
                    .split(" ")
                    .filter((flag) => flag !== missing)
                    .join(" ")
              : "",
          "linux",
          "restricted",
        ),
      ).toBe(false);
    },
  );
  it("qualifies the restricted runtime separately from legacy", async () => {
    const probe = async (command: string, args: string[]) =>
      command === "claude"
        ? args[0] === "--version"
          ? "2.1.325 (Claude Code)"
          : restrictedHelp
        : "";
    expect(await verifyClaudeScrub({}, probe, "linux", "restricted")).toBe(
      true,
    );
    expect(await verifyClaudeScrub({}, probe, "linux")).toBe(false);
  });
  it.each(["2.1.323 (Claude Code)", "2.1.326 (Claude Code)", "unknown"])(
    "refuses unqualified restricted version %s",
    async (version) => {
      expect(
        await verifyClaudeScrub(
          {},
          async (_command, args) =>
            args[0] === "--version" ? version : restrictedHelp,
          "linux",
          "restricted",
        ),
      ).toBe(false);
    },
  );
  it.each(restrictedHelp.split(" "))(
    "requires restricted capability %s",
    async (missing) => {
      expect(
        await verifyClaudeScrub(
          {},
          async (command, args) =>
            command === "claude"
              ? args[0] === "--version"
                ? "2.1.325 (Claude Code)"
                : restrictedHelp
                    .split(" ")
                    .filter((flag) => flag !== missing)
                    .join(" ")
              : "",
          "linux",
          "restricted",
        ),
      ).toBe(false);
    },
  );
  it("copies only runtime allowlist names and forces subprocess scrubbing", () => {
    const env = claudeEnvironment({
      PATH: "/bin",
      HOME: "/home/test",
      LANG: "C",
      LC_ALL: "C",
      TERM: "xterm",
      TMPDIR: "/tmp",
      USER: "test",
      SHELL: "/bin/sh",
      CLAUDE_CONFIG_DIR: "/config",
      ANTHROPIC_AUTH_TOKEN: "inherited",
      NODE_OPTIONS: "injection",
      AWS_SECRET_ACCESS_KEY: "excluded",
      CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "0",
      DISABLE_AUTOUPDATER: "0",
      BB_SECRET: "excluded",
    });
    expect(Object.keys(env).sort()).toEqual(
      [
        "PATH",
        "HOME",
        "LANG",
        "LC_ALL",
        "TERM",
        "TMPDIR",
        "USER",
        "SHELL",
        "CLAUDE_CONFIG_DIR",
        "CLAUDE_CODE_SUBPROCESS_ENV_SCRUB",
        "DISABLE_AUTOUPDATER",
      ].sort(),
    );
    expect(env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB).toBe("1");
    expect(env.DISABLE_AUTOUPDATER).toBe("1");
  });

  it.each(["2.1.322 (Claude Code)", "unknown"])(
    "refuses unsupported Claude %s",
    async (version) => {
      await expect(
        verifyClaudeScrub({}, async () => version, "linux"),
      ).resolves.toBe(false);
    },
  );

  it.each(["bwrap", "socat", "rg"])(
    "refuses missing or unusable %s",
    async (missing) => {
      await expect(
        verifyClaudeScrub(
          {},
          async (command) => {
            if (command === "claude") return "2.1.323 (Claude Code)";
            if (command === missing) throw new Error("isolation unavailable");
            return "";
          },
          "linux",
        ),
      ).resolves.toBe(false);
    },
  );

  it("requires a successful isolation probe with the scrubbed environment", async () => {
    const names: string[] = [];
    await expect(
      verifyClaudeScrub(
        { PATH: "/bin" },
        async (command, _args, env) => {
          names.push(command);
          expect(env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB).toBe("1");
          return command === "claude" ? "2.1.323 (Claude Code)" : "";
        },
        "linux",
      ),
    ).resolves.toBe(true);
    expect(names).toEqual(["claude", "socat", "rg", "bwrap"]);
  });

  it("fails closed on unsupported platforms", async () => {
    await expect(
      verifyClaudeScrub({}, async () => "2.1.323 (Claude Code)", "darwin"),
    ).resolves.toBe(false);
  });
});
