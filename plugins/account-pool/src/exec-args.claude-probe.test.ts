import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { parsePoolExecArgs } from "./exec-args.js";

it.runIf(process.env.BB_POOL_EXEC_CLAUDE_PROBE === "1")(
  "child started with the accepted flags has no tools, MCP servers or slash commands",
  () => {
    const args = parsePoolExecArgs("claude", [
      "--print",
      "--strict-mcp-config",
      "--disable-slash-commands",
      "--tools",
      "",
      "--model",
      "haiku",
      "--output-format",
      "text",
      "hi",
    ]);
    expect(args).not.toBeNull();
    const argv = (args ?? [])
      .filter((arg) => !arg.startsWith("--output-format"))
      .flatMap((arg) => (arg === "--" ? [] : [arg]));
    const prompt = argv.pop() ?? "hi";
    const result = spawnSync(
      "claude",
      [...argv, "--output-format", "stream-json", "--verbose", "--", prompt],
      {
        cwd: mkdtempSync(path.join(tmpdir(), "pool-exec-args-probe-")),
        encoding: "utf8",
        timeout: 120_000,
      },
    );
    const init = result.stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((event) => event.type === "system" && event.subtype === "init");
    expect(init).toBeDefined();
    expect(init?.tools).toEqual([]);
    expect(init?.mcp_servers).toEqual([]);
    expect(init?.slash_commands).toEqual([]);
  },
  150_000,
);
