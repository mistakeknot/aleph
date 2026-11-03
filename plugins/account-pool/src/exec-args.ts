import type { PoolProvider } from "./contracts.js";

const CODEX_FLAGS = new Set([
  "--ephemeral",
  "--ignore-user-config",
  "--ignore-rules",
  "--json",
]);
const CODEX_VALUES: Record<string, readonly string[] | null> = {
  "--model": null,
  "--sandbox": ["read-only", "workspace-write"],
  "--cd": null,
  "--output-schema": null,
  "--output-last-message": null,
  "--color": ["always", "never", "auto"],
};
const CLAUDE_FLAGS = new Set([
  "--print",
  "-p",
  "--strict-mcp-config",
  "--disable-slash-commands",
  "--safe-mode",
  "--no-session-persistence",
  "--no-chrome",
]);
const CLAUDE_VALUES: Record<string, readonly string[] | null> = {
  "--model": null,
  "--output-format": ["text", "json"],
  "--max-turns": null,
  "--json-schema": null,
  "--system-prompt": null,
};

export function poolExecArgsAllowed(
  provider: PoolProvider,
  args: readonly string[],
): boolean {
  return parsePoolExecArgs(provider, args) !== null;
}

export function parsePoolExecArgs(
  provider: PoolProvider,
  args: readonly string[],
): string[] | null {
  if (provider === "codex" && args[0] !== "exec") return null;
  if (provider === "claude" && args[0] !== "--print" && args[0] !== "-p")
    return null;
  const flags = provider === "codex" ? CODEX_FLAGS : CLAUDE_FLAGS;
  const values = provider === "codex" ? CODEX_VALUES : CLAUDE_VALUES;
  let prompt: string | undefined;
  const options: string[] = provider === "codex" ? ["exec"] : [];
  for (
    let index = provider === "codex" ? 1 : 0;
    index < args.length;
    index += 1
  ) {
    const arg = args[index] ?? "";
    if (flags.has(arg)) {
      options.push(arg);
      continue;
    }
    if (arg === "-" || !arg.startsWith("-")) {
      if (prompt !== undefined) return null;
      prompt = arg;
      continue;
    }
    const equals = arg.indexOf("=");
    const key = equals < 0 ? arg : arg.slice(0, equals);
    if (
      provider === "claude" &&
      (key === "--tools" || key === "--setting-sources")
    ) {
      const toolsValue = equals < 0 ? args[++index] : arg.slice(equals + 1);
      if (toolsValue !== "") return null;
      options.push(`${key}=`);
      continue;
    }
    if (provider === "claude" && key === "--mcp-config") {
      const value = equals < 0 ? args[++index] : arg.slice(equals + 1);
      if (!value) return null;
      try {
        const config: unknown = JSON.parse(value);
        if (
          typeof config !== "object" ||
          config === null ||
          Array.isArray(config) ||
          Object.keys(config).length !== 1 ||
          !("mcpServers" in config)
        )
          return null;
        const servers = config.mcpServers;
        if (
          typeof servers !== "object" ||
          servers === null ||
          Array.isArray(servers) ||
          Object.keys(servers).length !== 0
        )
          return null;
      } catch {
        return null;
      }
      options.push('--mcp-config={"mcpServers":{}}');
      continue;
    }
    if (!Object.hasOwn(values, key)) return null;
    const value = equals < 0 ? args[++index] : arg.slice(equals + 1);
    if (!value || value.startsWith("-")) return null;
    const choices = values[key];
    if (choices && !choices.includes(value)) return null;
    options.push(`${key}=${value}`);
  }
  return prompt === undefined ? options : [...options, "--", prompt];
}
