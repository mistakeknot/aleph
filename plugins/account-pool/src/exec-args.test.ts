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
