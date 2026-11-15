import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Claude pool tool routing", () => {
  it("keeps the independently bundled plugin helpers identical", () => {
    expect(
      readFileSync(
        new URL(
          "../../../plugins/account-pool/src/claude-pool-tools.ts",
          import.meta.url,
        ),
        "utf8",
      ),
    ).toBe(
      readFileSync(
        new URL(
          "../../../plugins/provider-claude-code/src/bridge/claude-pool-tools.ts",
          import.meta.url,
        ),
        "utf8",
      ),
    );
  });
});
