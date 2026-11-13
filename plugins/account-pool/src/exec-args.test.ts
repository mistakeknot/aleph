import { describe, expect, it } from "vitest";
import {
  parsePoolExecArgs,
  poolExecArgsAllowed,
  poolExecArgsRefusal,
} from "./exec-args.js";

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
      ["--print", "--resume=id"],
      ["--print", "--agents={}"],
      ["--print", "--mcp-config=x.json"],
      ["--print", "--mcp-config", "x.json", "hello"],
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

  const guards = ["--tools=", "--strict-mcp-config"];

  it("accepts empty settings sources only with empty tools and strict MCP config", () => {
    for (const option of [["--setting-sources", ""], ["--setting-sources="]]) {
      expect(
        parsePoolExecArgs("claude", [
          "--print",
          "--tools",
          "",
          "--strict-mcp-config",
          ...option,
        ]),
      ).toEqual([
        "--print",
        "--tools=",
        "--strict-mcp-config",
        "--setting-sources=",
      ]);
      expect(
        parsePoolExecArgs("claude", [
          "--print",
          ...option,
          "--strict-mcp-config",
          "--tools=",
        ]),
      ).toEqual([
        "--print",
        "--setting-sources=",
        "--strict-mcp-config",
        "--tools=",
      ]);
    }
  });

  it("refuses empty settings sources without empty tools", () => {
    for (const option of [["--setting-sources", ""], ["--setting-sources="]]) {
      expect(
        parsePoolExecArgs("claude", [
          "--print",
          "--strict-mcp-config",
          ...option,
          "review",
        ]),
      ).toBeNull();
    }
    expect(
      parsePoolExecArgs("claude", [
        "--print",
        "--strict-mcp-config",
        "--setting-sources=",
        "--tools",
        "Bash",
      ]),
    ).toBeNull();
  });

  it("refuses empty settings sources without strict MCP config", () => {
    for (const option of [["--setting-sources", ""], ["--setting-sources="]]) {
      expect(
        parsePoolExecArgs("claude", [
          "--print",
          "--tools=",
          ...option,
          "review",
        ]),
      ).toBeNull();
    }
  });

  it("refuses bare empty settings sources", () => {
    expect(
      parsePoolExecArgs("claude", ["--print", "--setting-sources", ""]),
    ).toBeNull();
    expect(
      parsePoolExecArgs("claude", ["--print", "--setting-sources="]),
    ).toBeNull();
    expect(
      poolExecArgsAllowed("claude", ["--print", "--setting-sources="]),
    ).toBe(false);
  });

  it("names the missing guards when refusing empty settings sources", () => {
    expect(
      poolExecArgsRefusal("claude", ["--print", "--setting-sources="]),
    ).toContain("--tools= and --strict-mcp-config");
    expect(
      poolExecArgsRefusal("claude", [
        "--print",
        "--setting-sources=",
        ...guards,
      ]),
    ).toBeNull();
    expect(poolExecArgsRefusal("claude", ["--print", "--bogus"])).toBe(
      "claude arguments are not permitted by the Account Pooler execution allowlist.",
    );
  });

  it("keeps non-empty settings sources refused with or without guards", () => {
    for (const value of ["user", "project", "local", "user,project", " "]) {
      for (const option of [
        ["--setting-sources", value],
        [`--setting-sources=${value}`],
      ]) {
        expect(parsePoolExecArgs("claude", ["--print", ...option])).toBeNull();
        expect(
          parsePoolExecArgs("claude", ["--print", ...guards, ...option]),
        ).toBeNull();
      }
    }
    expect(
      parsePoolExecArgs("claude", ["--print", "--setting-sources"]),
    ).toBeNull();
  });

  it.each([
    ["--add-dir", "relative"],
    ["--settings", "{}"],
    ["--plugin-dir", "/tmp"],
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

describe("bounded dispatch arguments", () => {
  it.each([
    ["--effort", "low"],
    ["--effort", "medium"],
    ["--effort", "high"],
    ["--effort", "xhigh"],
    ["--effort", "max"],
    ["--model", "model-id"],
    ["--permission-mode", "dontAsk"],
    ["--allowedTools", "Bash"],
    ["--allowedTools", "Bash,Edit,Write,NotebookEdit"],
    ["--disallowedTools", "Edit,Write,NotebookEdit,Agent,Task,Skill"],
    ["--disallowedTools", "Edit,Write,NotebookEdit"],
    ["--disallowedTools", "Agent,Task,Skill"],
    ["--output-format", "text"],
    ["--output-format", "json"],
    ["--output-format", "stream-json"],
    ["--setting-sources", "project,local"],
  ])("accepts %s %s with print last and stdin prompt", (flag, value) => {
    expect(parsePoolExecArgs("claude", [flag, value, "-p"])).toEqual([
      `${flag}=${value}`,
      "-p",
    ]);
  });
  it.each([
    ["--permission-mode", "default"],
    ["--permission-mode", "acceptEdits"],
    ["--permission-mode", "bypassPermissions"],
    ["--allowedTools", "*"],
    ["--allowedTools", "Bash(*)"],
    ["--disallowedTools", "Edit"],
    ["--effort", "ultra"],
    ["--verbose"],
    ["--output-format=json", "--verbose"],
    ["--setting-sources=project,local", "--setting-sources=project,local"],
  ])("refuses unsafe dispatch options %j", (...args) => {
    expect(parsePoolExecArgs("claude", [...args, "-p"])).toBeNull();
  });
  it("accepts verbose streaming", () => {
    expect(
      parsePoolExecArgs("claude", [
        "--verbose",
        "--output-format=stream-json",
        "-p",
      ]),
    ).not.toBeNull();
  });
  it("bounds add-dir count and rejects traversal or relative spelling", () => {
    expect(parsePoolExecArgs("claude", ["--add-dir=/work/plan", "-p"])).toEqual(
      ["--add-dir=/work/plan", "-p"],
    );
    for (const options of [
      ["--add-dir=relative"],
      ["--add-dir=/work/../outside"],
      ["--add-dir=/work/a", "--add-dir=/work/b"],
    ])
      expect(parsePoolExecArgs("claude", [...options, "-p"])).toBeNull();
  });
});
