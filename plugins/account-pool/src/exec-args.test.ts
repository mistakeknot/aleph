import { describe, expect, it } from "vitest";
import { parsePoolExecArgs, poolExecArgsAllowed } from "./exec-args.js";

describe("pool exec argument allowlist", () => {
  it("quotes the prompt behind an option terminator so it cannot select a subcommand", () => {
    expect(
      parsePoolExecArgs("codex", ["exec", "review", "--model", "gpt-5"]),
    ).toEqual(["exec", "--model=gpt-5", "--", "review"]);
  });
  it("accepts only bounded Codex exec and Claude print options", () => {
    expect(
      poolExecArgsAllowed("codex", [
        "exec",
        "--sandbox=workspace-write",
        "--cd",
        "/work",
        "--json",
        "-",
      ]),
    ).toBe(true);
    expect(
      poolExecArgsAllowed("claude", ["--print", "--model", "sonnet", "hello"]),
    ).toBe(true);
    for (const args of [
      ["exec", "--sandbox=danger-full-access"],
      ["exec", "--model", "-cfoo=bar"],
      ["exec", "--config", "model=5"],
      ["exec", "--profile=x"],
      ["exec", "--enable=feature"],
      ["exec", "--model"],
      ["exec", "--", "-cfoo=bar"],
    ]) {
      expect(poolExecArgsAllowed("codex", args)).toBe(false);
    }
    for (const args of [
      ["--print", "--settings={}"],
      ["--setting-sources", "project", "--print", "hello"],
      ["--print", "--setting-sources", "project,local", "hello"],
      ["--print", "--setting-sources=project,local", "hello"],
      ["--print", "--resume=id"],
      ["--print", "--agents={}"],
      ["--print", "--mcp-config=x.json"],
      ["--print", "--mcp-config", "x.json", "hello"],
      ["--print", "--allowedTools", "Bash"],
      ["--print", "--allowedTools=Bash"],
      ["--print", "--tools", "Bash", "hello"],
      ["--print", "--tools=default"],
      ["--print", "--tools"],
      ["--version"],
      ["--print", "--dangerously-skip-permissions"],
    ]) {
      expect(poolExecArgsAllowed("claude", args)).toBe(false);
    }
  });
  it("accepts only capability-removing Claude flags and normalizes empty --tools", () => {
    expect(
      parsePoolExecArgs("claude", [
        "--print",
        "--strict-mcp-config",
        "--disable-slash-commands",
        "--tools",
        "",
        "--model",
        "haiku",
        "text",
      ]),
    ).toEqual([
      "--print",
      "--strict-mcp-config",
      "--disable-slash-commands",
      "--tools=",
      "--model=haiku",
      "--",
      "text",
    ]);
    expect(parsePoolExecArgs("claude", ["-p", "--tools=", "x"])).toEqual([
      "-p",
      "--tools=",
      "--",
      "x",
    ]);
    expect(poolExecArgsAllowed("codex", ["exec", "--tools="])).toBe(false);
    expect(poolExecArgsAllowed("codex", ["exec", "--strict-mcp-config"])).toBe(
      false,
    );
  });
});

describe("restrictive Claude reviewer arguments", () => {
  it.each(["--safe-mode", "--no-session-persistence", "--no-chrome"])(
    "accepts %s only for Claude",
    (flag) => {
      expect(parsePoolExecArgs("claude", ["--print", flag, "review"])).toEqual([
        "--print",
        flag,
        "--",
        "review",
      ]);
      expect(
        parsePoolExecArgs("claude", ["--print", `${flag}=true`]),
      ).toBeNull();
      expect(parsePoolExecArgs("codex", ["exec", flag])).toBeNull();
    },
  );

  it.each(["--json-schema", "--system-prompt"])(
    "normalizes both forms of %s",
    (flag) => {
      const value =
        flag === "--json-schema"
          ? '{"type":"object"}'
          : "Review text only\nDo not execute commands";
      for (const option of [[flag, value], [`${flag}=${value}`]]) {
        expect(
          parsePoolExecArgs("claude", ["-p", ...option, "review"]),
        ).toEqual(["-p", `${flag}=${value}`, "--", "review"]);
      }
      for (const option of [
        [flag],
        [flag, ""],
        [`${flag}=`],
        [flag, "--settings=x"],
      ]) {
        expect(parsePoolExecArgs("claude", ["-p", ...option])).toBeNull();
      }
      expect(parsePoolExecArgs("codex", ["exec", flag, value])).toBeNull();
    },
  );

  it.each(['{"mcpServers":{}}', ' { "mcpServers" : {} } '])(
    "accepts only inline empty MCP config %s",
    (value) => {
      for (const option of [
        ["--mcp-config", value],
        [`--mcp-config=${value}`],
      ]) {
        expect(
          parsePoolExecArgs("claude", ["--print", ...option, "review"]),
        ).toEqual([
          "--print",
          '--mcp-config={"mcpServers":{}}',
          "--",
          "review",
        ]);
      }
    },
  );

  it.each([
    "",
    "config.json",
    "/tmp/config.json",
    "{}",
    "null",
    "[]",
    "false",
    '"config.json"',
    '{"mcpServers":null}',
    '{"mcpServers":[]}',
    '{"mcpServers":{"x":{"command":"sh"}}}',
    '{"mcpServers":{"x":{"url":"https://example.com"}}}',
    '{"mcpServers":{},"other":{}}',
    '{"mcpServers":{},"__proto__":{}}',
    '{"mcpServers":{}} trailing',
    '{"mcpServers":',
  ])("rejects unsafe or ambiguous MCP config %s", (value) => {
    for (const option of [["--mcp-config", value], [`--mcp-config=${value}`]]) {
      expect(parsePoolExecArgs("claude", ["--print", ...option])).toBeNull();
    }
  });

  it("rejects missing or multiple MCP config values", () => {
    expect(parsePoolExecArgs("claude", ["--print", "--mcp-config"])).toBeNull();
    expect(
      parsePoolExecArgs("claude", [
        "--print",
        '--mcp-config={"mcpServers":{}}',
        "config.json",
        "review",
      ]),
    ).toBeNull();
    expect(
      parsePoolExecArgs("claude", [
        "--print",
        '--mcp-config={"mcpServers":{}}',
        '--mcp-config={"mcpServers":{"x":{}}}',
      ]),
    ).toBeNull();
  });

  it("accepts only empty settings sources", () => {
    for (const option of [["--setting-sources", ""], ["--setting-sources="]]) {
      expect(parsePoolExecArgs("claude", ["--print", ...option])).toEqual([
        "--print",
        "--setting-sources=",
      ]);
    }
    for (const value of ["user", "project", "local", "user,project", " "]) {
      for (const option of [
        ["--setting-sources", value],
        [`--setting-sources=${value}`],
      ]) {
        expect(parsePoolExecArgs("claude", ["--print", ...option])).toBeNull();
      }
    }
    expect(
      parsePoolExecArgs("claude", ["--print", "--setting-sources"]),
    ).toBeNull();
  });

  it.each([
    ["--add-dir", "/tmp"],
    ["--settings", "{}"],
    ["--plugin-dir", "/tmp"],
    ["--allowedTools", "Bash"],
    ["--allowed-tools", "Bash"],
    ["--tools", "Bash"],
    ["--permission-mode", "bypassPermissions"],
    ["--dangerously-skip-permissions"],
    ["--allow-dangerously-skip-permissions"],
    ["--chrome"],
    ["--agents", "{}"],
    ["--system-prompt-file", "/tmp/prompt"],
    ["--append-system-prompt-file", "/tmp/prompt"],
  ])("rejects capability-adding option %s", (...option) => {
    expect(
      parsePoolExecArgs("claude", ["--print", ...option, "review"]),
    ).toBeNull();
    if (option.length === 2) {
      expect(
        parsePoolExecArgs("claude", [
          "--print",
          `${option[0]}=${option[1]}`,
          "review",
        ]),
      ).toBeNull();
    }
  });

  it("parses the complete pooled reviewer line with stdin and structured output", () => {
    const schema = JSON.stringify({
      type: "object",
      properties: { body: { type: "string", minLength: 1, maxLength: 50000 } },
      required: ["body"],
      additionalProperties: false,
    });
    const system =
      "Review supplied text only. Do not execute commands or enable tools.";
    expect(
      parsePoolExecArgs("claude", [
        "--print",
        "--safe-mode",
        "--tools",
        "",
        "--strict-mcp-config",
        "--mcp-config",
        '{"mcpServers":{}}',
        "--disable-slash-commands",
        "--no-session-persistence",
        "--no-chrome",
        "--setting-sources",
        "",
        "--output-format",
        "json",
        "--json-schema",
        schema,
        "--system-prompt",
        system,
        "-",
      ]),
    ).toEqual([
      "--print",
      "--safe-mode",
      "--tools=",
      "--strict-mcp-config",
      '--mcp-config={"mcpServers":{}}',
      "--disable-slash-commands",
      "--no-session-persistence",
      "--no-chrome",
      "--setting-sources=",
      "--output-format=json",
      `--json-schema=${schema}`,
      `--system-prompt=${system}`,
      "--",
      "-",
    ]);
  });
});
