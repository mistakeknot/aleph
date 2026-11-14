import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const wrappers = new Map<string, string>();

function quote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
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
  let wrapper = wrappers.get(prefix);
  if (wrapper === undefined) {
    const directory = mkdtempSync(join(tmpdir(), "bb-claude-pool-tools-"));
    wrapper = join(directory, "shell");
    const split = prefix.lastIndexOf(" -");
    const command = prefix
      ? split > 0
        ? `${quote(prefix.slice(0, split))} ${prefix.slice(split + 1)} "$1"`
        : `${quote(prefix)} "$1"`
      : '/bin/sh -c "$1"';
    writeFileSync(
      wrapper,
      `#!/bin/sh\nunset ANTHROPIC_AUTH_TOKEN ANTHROPIC_BASE_URL CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST\nexec ${command}\n`,
      { mode: 0o500 },
    );
    wrappers.set(prefix, wrapper);
  }
  return { ...env, CLAUDE_CODE_SHELL_PREFIX: wrapper };
}
