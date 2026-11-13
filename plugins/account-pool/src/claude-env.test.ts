import { describe, expect, it } from "vitest";
import { claudeEnvironment, verifyClaudeScrub } from "./claude-env.js";

describe("Claude pool environment", () => {
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
      ].sort(),
    );
    expect(env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB).toBe("1");
  });

  it.each(["2.1.322 (Claude Code)", "unknown"])(
    "refuses unsupported Claude %s",
    async (version) => {
      await expect(
        verifyClaudeScrub({}, async () => version, "linux"),
      ).resolves.toBe(false);
    },
  );

  it("refuses missing or unusable bubblewrap", async () => {
    await expect(
      verifyClaudeScrub(
        {},
        async (command) => {
          if (command === "claude") return "2.1.323 (Claude Code)";
          throw new Error("isolation unavailable");
        },
        "linux",
      ),
    ).resolves.toBe(false);
  });

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
    expect(names).toEqual(["claude", "bwrap"]);
  });

  it("fails closed on unsupported platforms", async () => {
    await expect(
      verifyClaudeScrub({}, async () => "2.1.323 (Claude Code)", "darwin"),
    ).resolves.toBe(false);
  });
});
