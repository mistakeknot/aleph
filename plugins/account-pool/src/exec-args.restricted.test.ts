import { describe, expect, it } from "vitest";
import { parsePoolExecArgs, poolExecArgsRefusal } from "./exec-args.js";

const controls = [
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

describe("coupled restricted Claude profile", () => {
  it("names the restricted profile when its coupled controls are incomplete", () => {
    expect(poolExecArgsRefusal("claude", ["--restricted", "-p"])).toContain(
      "restricted review profile",
    );
  });
  it("normalizes split and equals values with print last", () => {
    const expected = [
      ...controls,
      "--output-format=stream-json",
      "--verbose",
      "-p",
    ];
    expect(parsePoolExecArgs("claude", expected)).toEqual(expected);
    const split = expected.flatMap((option) => {
      const equals = option.indexOf("=");
      return equals < 0
        ? [option]
        : [option.slice(0, equals), option.slice(equals + 1)];
    });
    expect(parsePoolExecArgs("claude", split)).toEqual(expected);
    expect(parsePoolExecArgs("claude", ["review", ...expected])).toBeNull();
    expect(parsePoolExecArgs("claude", [...expected, "-"])).toBeNull();
  });

  it.each(controls)("refuses missing control %s", (control) => {
    expect(
      parsePoolExecArgs("claude", [
        ...controls.filter((item) => item !== control),
        "-p",
      ]),
    ).toBeNull();
  });

  it.each([...controls, "-p", "--print"])(
    "refuses duplicate security option %s",
    (control) => {
      expect(
        parsePoolExecArgs("claude", [...controls, "-p", control]),
      ).toBeNull();
    },
  );

  it.each([
    "--tools=",
    "--tools=Bash",
    "--tools=Write",
    "--tools=default",
    "--tools=*",
    "--tools=Read(*)",
    "--tools=Grep,Read,Glob",
    "--allowedTools=Read,Glob,Grep",
    "--allowedTools=Bash",
    "--allowedTools=Bash,Edit,Write,NotebookEdit",
    "--permission-mode=default",
    "--permission-mode=bypassPermissions",
    "--setting-sources=project,local",
    "--setting-sources=user",
    "--setting-sources=project",
    "--setting-sources=local",
    "--disallowedTools=Edit,Write,NotebookEdit",
    "--restricted=true",
    "--restricted=",
    "--system-prompt=review",
    "--json-schema={}",
    "--max-turns=1",
    "--input-format=text",
    "--input-format=stream-json",
    "--include-partial-messages",
    "--session-id=id",
    "--tools=read,glob,grep",
    "--tools=Read, Glob, Grep",
    "--tools=Read,Glob,Grep,Bash",
    "--add-dir=/workspace/plan",
    "--effort=ultra",
    "--model=",
    "--output-format=bad",
  ])("refuses altered or mixed option %s", (option) => {
    const key = option.split("=")[0];
    const args = controls.filter((item) => item.split("=")[0] !== key);
    expect(parsePoolExecArgs("claude", [...args, option, "-p"])).toBeNull();
  });

  it("does not treat option data as a profile selector", () => {
    expect(
      parsePoolExecArgs("claude", ["--model", "--restricted", "-p"]),
    ).toBeNull();
    expect(
      parsePoolExecArgs("claude", ["--system-prompt=--restricted", "-p"]),
    ).toBeNull();
    expect(
      parsePoolExecArgs("claude", ["--tools", "--restricted", "-p"]),
    ).toBeNull();
    expect(parsePoolExecArgs("claude", [...controls, "--", "-p"])).toBeNull();
    expect(
      parsePoolExecArgs("claude", ["--tools=Read,Glob,Grep", "-p"]),
    ).toBeNull();
    expect(parsePoolExecArgs("claude", [controls[4]!, "-p"])).toBeNull();
  });
});
