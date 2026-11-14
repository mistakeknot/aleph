import { lstatSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { whichCommandSync } from "which-command";

const wrappers = new Map<string, string>();

function quote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function shellFor(env: NodeJS.ProcessEnv): string {
  for (const candidate of [
    env.CLAUDE_CODE_SHELL,
    env.SHELL,
    "zsh",
    "bash",
    "/bin/zsh",
    "/bin/bash",
  ]) {
    if (!candidate || !["bash", "zsh"].includes(basename(candidate))) continue;
    const executable = whichCommandSync(candidate, { path: env.PATH ?? "" });
    if (executable) return executable;
  }
  throw new Error(
    "Pooled Claude tools require an executable bash or zsh shell.",
  );
}

function reusable(path: string, content: string): boolean {
  try {
    const file = lstatSync(path);
    return (
      file.isFile() &&
      (file.mode & 0o777) === 0o500 &&
      readFileSync(path, "utf8") === content
    );
  } catch {
    return false;
  }
}

export function isolateClaudePoolTools(
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  if (
    process.platform === "win32" ||
    env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST !== "1" ||
    !env.ANTHROPIC_AUTH_TOKEN ||
    !env.ANTHROPIC_BASE_URL?.endsWith("/api/v1/plugins/account-pool/http")
  )
    return env;

  const prefix = env.CLAUDE_CODE_SHELL_PREFIX ?? "";
  const shell = prefix ? "" : shellFor(env);
  const key = `${prefix}\0${shell}`;
  const split = prefix.lastIndexOf(" -");
  const command = prefix
    ? split > 0
      ? `${quote(prefix.slice(0, split))} ${prefix.slice(split + 1)} "$1"`
      : `${quote(prefix)} "$1"`
    : `${quote(shell)} -c "$1"`;
  const content = `#!/bin/sh\nunset ANTHROPIC_AUTH_TOKEN ANTHROPIC_BASE_URL CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST\nexec ${command}\n`;
  let wrapper = wrappers.get(key);
  if (wrapper === undefined || !reusable(wrapper, content)) {
    const directory = mkdtempSync(join(tmpdir(), "bb-claude-pool-tools-"));
    wrapper = join(directory, "shell");
    writeFileSync(wrapper, content, { mode: 0o500 });
    wrappers.set(key, wrapper);
  }
  return { ...env, CLAUDE_CODE_SHELL_PREFIX: wrapper };
}
