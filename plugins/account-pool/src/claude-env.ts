import { execFile } from "node:child_process";

const RUNTIME_NAMES = new Set([
  "PATH",
  "HOME",
  "LANG",
  "TERM",
  "TMPDIR",
  "USER",
  "SHELL",
  "CLAUDE_CONFIG_DIR",
]);

export function claudeEnvironment(
  source: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    if (
      value !== undefined &&
      (RUNTIME_NAMES.has(name) || /^LC_[A-Z_]+$/.test(name))
    )
      env[name] = value;
  }
  env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB = "1";
  env.DISABLE_AUTOUPDATER = "1";
  return env;
}

type Probe = (
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
) => Promise<string>;

const runProbe: Probe = (command, args, env) =>
  new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { env, timeout: 5_000, maxBuffer: 65_536 },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      },
    );
  });

export async function verifyClaudeScrub(
  source: NodeJS.ProcessEnv,
  probe: Probe = runProbe,
  platform: NodeJS.Platform = process.platform,
  profile: "legacy" | "restricted" = "legacy",
): Promise<boolean> {
  if (platform !== "linux") return false;
  const env = claudeEnvironment(source);
  try {
    const version = (await probe("claude", ["--version"], env)).trim();
    if (
      version !==
      `${profile === "restricted" ? "2.1.325" : "2.1.323"} (Claude Code)`
    )
      return false;
    if (profile === "restricted") {
      const help = await probe("claude", ["--help"], env);
      if (
        ![
          "--restricted",
          "--safe-mode",
          "--tools",
          "--permission-mode",
          "--strict-mcp-config",
          "--no-chrome",
          "--no-session-persistence",
          "--disable-slash-commands",
        ].every((flag) => help.includes(flag))
      )
        return false;
    }
    await probe("socat", ["-V"], env);
    await probe("rg", ["--version"], env);
    await probe(
      "bwrap",
      [
        "--unshare-user",
        "--disable-userns",
        "--unshare-pid",
        "--unshare-net",
        "--ro-bind",
        "/",
        "/",
        "--proc",
        "/proc",
        "--dev",
        "/dev",
        "--",
        "/bin/true",
      ],
      env,
    );
    return true;
  } catch {
    return false;
  }
}
