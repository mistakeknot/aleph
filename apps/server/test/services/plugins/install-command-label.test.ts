import { describe, expect, it } from "vitest";
import { runInstallCommand } from "../../../src/services/plugins/install-sources.js";

describe("runInstallCommand failure messages", () => {
  it("names the first argument by default", async () => {
    await expect(
      runInstallCommand(process.execPath, ["-e", "process.exit(3)"]),
    ).rejects.toThrow(`${process.execPath} -e failed (exit 3)`);
  });

  it("names the caller's label instead of the leading argument", async () => {
    await expect(
      runInstallCommand(
        process.execPath,
        ["--no-warnings", "-e", "process.exit(3)"],
        { label: "plugin build worker" },
      ),
    ).rejects.toThrow("plugin build worker failed (exit 3)");
  });
});
