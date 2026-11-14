import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isolateClaudePoolTools } from "../src/claude-pool-tools.js";

describe.skipIf(process.platform === "win32")("Claude pool tool routing", () => {
  it.skipIf(!process.env.BB_TEST_CLAUDE_EXECUTABLE)(
    "isolates an actual Claude Bash tool while keeping the parent authenticated",
    () => {
      const env = isolateClaudePoolTools({
        ANTHROPIC_BASE_URL:
          "https://example.test/api/v1/plugins/account-pool/http",
        ANTHROPIC_AUTH_TOKEN: "synthetic-secret",
        CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: "1",
      });
      const port = execFileSync("free-port", { encoding: "utf8" }).trim();
      const output = execFileSync(
        "python3",
        [
          join(import.meta.dirname, "fixtures/claude-tool-env.py"),
          process.env.BB_TEST_CLAUDE_EXECUTABLE!,
          port,
          env.CLAUDE_CODE_SHELL_PREFIX ?? "",
        ],
        { encoding: "utf8", timeout: 50_000 },
      );
      expect(output).toContain(
        "actual Claude Bash environment clean; parent route authenticated",
      );
    },
    55_000,
  );
  it("keeps the parent pooled while removing routing from a shell child", () => {
    const source = {
      PATH: process.env.PATH,
      ANTHROPIC_BASE_URL:
        "https://example.test/api/v1/plugins/account-pool/http",
      ANTHROPIC_AUTH_TOKEN: "synthetic-secret",
      CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: "1",
    };
    const env = isolateClaudePoolTools(source);
    const command = `${JSON.stringify(process.execPath)} -e 'console.log(JSON.stringify(["ANTHROPIC_BASE_URL","ANTHROPIC_AUTH_TOKEN","CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST"].map(k=>Object.hasOwn(process.env,k))))'`;
    const output = execFileSync(
      env.CLAUDE_CODE_SHELL_PREFIX ?? "/bin/sh",
      env.CLAUDE_CODE_SHELL_PREFIX ? [command] : ["-c", command],
      { env, encoding: "utf8" },
    );
    expect(JSON.parse(output)).toEqual([false, false, false]);
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe(source.ANTHROPIC_AUTH_TOKEN);
    expect(env.ANTHROPIC_BASE_URL).toBe(source.ANTHROPIC_BASE_URL);
    expect(env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST).toBe("1");
    expect(source).not.toHaveProperty("CLAUDE_CODE_SHELL_PREFIX");
  });

  it("leaves unrelated and unpooled environments alone", () => {
    for (const source of [{}, { ANTHROPIC_BASE_URL: "https://example.test" }]) {
      expect(isolateClaudePoolTools(source)).toBe(source);
    }
  });

  it("preserves an existing shell prefix after removing routing", () => {
    const directory = mkdtempSync(join(tmpdir(), "claude-prefix-test-"));
    try {
      const prefix = join(directory, "operator's wrapper");
      writeFileSync(
        prefix,
        '#!/bin/sh\nexport OPERATOR_WRAPPER=used\nexec /bin/sh -c "$1"\n',
        { mode: 0o700 },
      );
      const env = isolateClaudePoolTools({
        PATH: process.env.PATH,
        ANTHROPIC_BASE_URL:
          "https://example.test/api/v1/plugins/account-pool/http",
        ANTHROPIC_AUTH_TOKEN: "synthetic-secret",
        CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: "1",
        CLAUDE_CODE_SHELL_PREFIX: prefix,
      });
      const output = execFileSync(
        env.CLAUDE_CODE_SHELL_PREFIX!,
        ['printf "%s:%s" "$OPERATOR_WRAPPER" "${ANTHROPIC_BASE_URL-unset}"'],
        { env, encoding: "utf8" },
      );
      expect(output).toBe("used:unset");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
