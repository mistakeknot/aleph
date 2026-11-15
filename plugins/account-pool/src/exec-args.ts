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
  "--restricted",
  "--verbose",
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
  "--add-dir": null,
  "--output-format": ["text", "json", "stream-json"],
  "--effort": ["low", "medium", "high", "xhigh", "max"],
  "--permission-mode": ["dontAsk"],
  "--allowedTools": ["Bash", "Bash,Edit,Write,NotebookEdit"],
  "--disallowedTools": [
    "Bash,PowerShell,Edit,Write,NotebookEdit,Agent,Task,Skill,WebFetch,WebSearch",
    "Edit,Write,NotebookEdit,Agent,Task,Skill",
    "Edit,Write,NotebookEdit",
    "Agent,Task,Skill",
  ],
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

const EMPTY_SETTING_SOURCES_GUARDS = ["--tools=", "--strict-mcp-config"];
const EMPTY_SETTING_SOURCES_REFUSAL =
  "claude --setting-sources '' is permitted only together with --tools= and --strict-mcp-config because it also drops user-settings protections.";

export const RESTRICTED_CLAUDE_CONTROLS = [
  "--restricted",
  "--safe-mode",
  "--tools=Read,Glob,Grep",
  "--permission-mode=dontAsk",
  "--disallowedTools=Bash,PowerShell,Edit,Write,NotebookEdit,Agent,Task,Skill,WebFetch,WebSearch",
  "--setting-sources=",
  "--strict-mcp-config",
  '--mcp-config={"mcpServers":{}}',
  "--disable-slash-commands",
  "--no-chrome",
  "--no-session-persistence",
];

export function parsePoolExecArgs(
  provider: PoolProvider,
  args: readonly string[],
): string[] | null {
  const options = parseUnguardedPoolExecArgs(provider, args);
  if (options === null) return null;
  const terminator = options.indexOf("--");
  const flags = terminator < 0 ? options : options.slice(0, terminator);
  if (provider === "claude" && flags.includes("--restricted")) {
    const keys = flags.map((option) =>
      option === "-p" ? "--print" : option.split("=")[0],
    );
    if (new Set(keys).size !== keys.length) return null;
    if (!RESTRICTED_CLAUDE_CONTROLS.every((control) => flags.includes(control)))
      return null;
    if (
      keys.some((key) =>
        [
          "--allowedTools",
          "--system-prompt",
          "--json-schema",
          "--max-turns",
        ].includes(key ?? ""),
      )
    )
      return null;
    return options;
  }
  if (
    flags.includes("--tools=Read,Glob,Grep") ||
    flags.includes(RESTRICTED_CLAUDE_CONTROLS[4]!)
  )
    return null;
  if (
    options?.includes("--setting-sources=project,local") &&
    (!options.includes("--permission-mode=dontAsk") ||
      !options.some((option) => option.startsWith("--allowedTools=")))
  )
    return null;
  if (
    options?.includes("--setting-sources=") &&
    !EMPTY_SETTING_SOURCES_GUARDS.every((guard) => options.includes(guard))
  )
    return null;
  return options;
}

export function poolExecArgsRefusal(
  provider: PoolProvider,
  args: readonly string[],
): string | null {
  if (parsePoolExecArgs(provider, args) !== null) return null;
  const options = parseUnguardedPoolExecArgs(provider, args);
  const terminator = options?.indexOf("--") ?? -1;
  const flags = terminator < 0 ? options : options?.slice(0, terminator);
  if (
    provider === "claude" &&
    flags?.some(
      (flag) =>
        flag === "--restricted" ||
        flag === "--tools=Read,Glob,Grep" ||
        flag === RESTRICTED_CLAUDE_CONTROLS[4],
    )
  )
    return "claude requires the complete restricted review profile; caller tool allowances and nonempty settings are refused.";
  if (
    parseUnguardedPoolExecArgs(provider, args)?.includes(
      "--setting-sources=project,local",
    )
  )
    return "claude project,local settings require --permission-mode dontAsk and a fixed --allowedTools value.";
  if (parseUnguardedPoolExecArgs(provider, args) !== null)
    return EMPTY_SETTING_SOURCES_REFUSAL;
  return `${provider} arguments are not permitted by the Account Pooler execution allowlist.`;
}

function parseUnguardedPoolExecArgs(
  provider: PoolProvider,
  args: readonly string[],
): string[] | null {
  if (provider === "codex" && args[0] !== "exec") return null;
  if (
    provider === "claude" &&
    !args.includes("--print") &&
    !args.includes("-p")
  )
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
      const emptyValue = equals < 0 ? args[++index] : arg.slice(equals + 1);
      if (
        emptyValue !== "" &&
        !(key === "--tools" && emptyValue === "Read,Glob,Grep") &&
        !(key === "--setting-sources" && emptyValue === "project,local")
      )
        return null;
      if (options.some((option) => option.startsWith(`${key}=`))) return null;
      options.push(`${key}=${emptyValue}`);
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
          !Object.hasOwn(config, "mcpServers")
        )
          return null;
        const servers: unknown = Reflect.get(config, "mcpServers");
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
    if (
      provider === "claude" &&
      options.some((option) => option.startsWith(`${key}=`))
    )
      return null;
    if (
      provider === "claude" &&
      key === "--add-dir" &&
      (!value.startsWith("/") || value.split("/").includes(".."))
    )
      return null;
    const choices = values[key];
    if (choices && !choices.includes(value)) return null;
    options.push(`${key}=${value}`);
  }
  if (
    options.includes("--verbose") &&
    !options.includes("--output-format=stream-json")
  )
    return null;
  return prompt === undefined ? options : [...options, "--", prompt];
}
