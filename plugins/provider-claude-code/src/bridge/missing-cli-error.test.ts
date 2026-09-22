import { experimental_BridgeMissingExecutableError } from "@get-bb/plugin-sdk/provider-bridge";
import { describe, expect, it } from "vitest";
import {
  translateMissingClaudeCliCatalogError,
  translateMissingClaudeCliError,
} from "./missing-cli-error.js";

const MISSING_CLI = new Error(
  "Native CLI binary for darwin-arm64 not found at /tmp/cli",
);

describe("missing Claude CLI errors", () => {
  it("types a catalog probe failure so the daemon classifies it without message sniffing", () => {
    const translated = translateMissingClaudeCliCatalogError(MISSING_CLI);

    expect(translated).toBeInstanceOf(
      experimental_BridgeMissingExecutableError,
    );
    expect((translated as Error).message).toContain(
      "could not find the Claude Code CLI",
    );
    expect((translated as Error).cause).toBe(MISSING_CLI);
  });

  it("leaves unrelated failures and non-catalog guidance untyped", () => {
    const unrelated = new Error("Session closed");

    expect(translateMissingClaudeCliCatalogError(unrelated)).toBe(unrelated);
    expect(translateMissingClaudeCliError(MISSING_CLI)).not.toBeInstanceOf(
      experimental_BridgeMissingExecutableError,
    );
  });
});
