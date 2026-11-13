import { describe, expect, it } from "vitest";
import { runPreRunCheck, supportsPreRunCheck } from "./pre-run-check.js";

describe("pre-run checks", () => {
  it("accepts only explicit local full-access paths", () => {
    const execution = {
      permissionMode: "full",
      environment: {
        type: "host",
        hostId: "local",
        workspace: { type: "unmanaged", path: process.cwd() },
      },
    };
    expect(supportsPreRunCheck(execution, "local")).toBe(true);
    expect(supportsPreRunCheck(execution, "remote")).toBe(false);
    expect(
      supportsPreRunCheck({ ...execution, permissionMode: "auto" }, "local"),
    ).toBe(false);
  });

  it("passes zero and captures a bounded stderr tail on nonzero", async () => {
    expect(
      (await runPreRunCheck({ command: "exit 0", cwd: process.cwd() }))
        .exitCode,
    ).toBe(0);
    const result = await runPreRunCheck({
      command: "printf '%03000dEND' 0 >&2; exit 7",
      cwd: process.cwd(),
    });
    expect(result.exitCode).toBe(7);
    expect(Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(2048);
    expect(result.stderr.endsWith("END")).toBe(true);
  });

  it("fails closed on timeout and spawn failure", async () => {
    expect(
      (
        await runPreRunCheck({
          command: "sleep 10",
          cwd: process.cwd(),
          timeoutMs: 20,
        })
      ).reason,
    ).toBe("check timed out");
    expect(
      (
        await runPreRunCheck({
          command: "exit 0",
          cwd: "/missing-check-directory",
        })
      ).reason,
    ).toBe("check failed to spawn");
  });
});
