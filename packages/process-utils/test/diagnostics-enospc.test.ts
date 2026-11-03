import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    writeFileSync: (path: string) => {
      // A full disk lets the file be created and then refuses the data, which
      // leaves a zero-byte report behind.
      actual.writeFileSync(path, "");
      throw Object.assign(new Error("ENOSPC: no space left on device, write"), {
        code: "ENOSPC",
      });
    },
  };
});

import {
  installSafeProcessDiagnostics,
  writeSafeProcessDiagnosticReport,
} from "../src/diagnostics.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

function createLogsDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "bb-diagnostics-enospc-"));
  tempDirs.push(dir);
  return dir;
}

describe("process diagnostics on a full disk", () => {
  it("removes the empty report file and reports the write failure", () => {
    const logsDir = createLogsDir();

    expect(() =>
      writeSafeProcessDiagnosticReport({
        kind: "startupFailure",
        logsDir,
        processName: "server",
        error: new Error("boom"),
      }),
    ).toThrow(/ENOSPC/);
    expect(readdirSync(logsDir)).toEqual([]);
  });

  it("lets the uncaughtException monitor swallow the write failure", () => {
    const logsDir = createLogsDir();
    const uninstall = installSafeProcessDiagnostics({
      logsDir,
      processName: "server",
    });
    try {
      expect(() =>
        (process as NodeJS.EventEmitter).emit(
          "uncaughtExceptionMonitor",
          new Error("boom"),
          "uncaughtException",
        ),
      ).not.toThrow();
    } finally {
      uninstall();
    }
    expect(existsSync(logsDir)).toBe(true);
    expect(readdirSync(logsDir)).toEqual([]);
  });
});
