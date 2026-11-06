import { existsSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  preparePrivateDirectory,
  preparePrivateFile,
  privacyCapability,
  StoreSecurityError,
  tightenPrivateFileIfPresent,
  type PrivacyIdentity,
} from "../src/private-fs.js";
import { cleanupStoreDirs, makeStoreDir } from "./support/store-helpers.js";

const WINDOWS_LIKE: PrivacyIdentity = {
  platform: "win32",
  getuid: undefined,
};

afterEach(() => {
  cleanupStoreDirs();
});

function refusal(action: () => void): StoreSecurityError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(StoreSecurityError);
    return error as StoreSecurityError;
  }
  throw new Error("expected the operation to be refused");
}

describe("privacy capability report", () => {
  it("reports owner-only enforcement where the platform has a user identity", () => {
    const report = privacyCapability({ platform: "linux", getuid: () => 1000 });
    expect(report).toEqual({
      enforced: true,
      platform: "linux",
      mechanism: "posix-owner-and-mode",
      reason: null,
    });
  });

  it("reports that enforcement is unavailable without a user identity", () => {
    const report = privacyCapability(WINDOWS_LIKE);
    expect(report.enforced).toBe(false);
    expect(report.mechanism).toBe("none");
    expect(report.platform).toBe("win32");
    expect(report.reason).toContain("owner-only");
  });
});

describe("platforms without a user identity", () => {
  it("refuses to prepare a directory and creates nothing", () => {
    const parent = makeStoreDir();
    const target = join(parent, "child");
    const error = refusal(() => preparePrivateDirectory(target, WINDOWS_LIKE));
    expect(error.code).toBe("unsupported_platform");
    expect(error.message).toContain("refusing to create or open the store");
    expect(existsSync(target)).toBe(false);
  });

  it("refuses to prepare a file and creates nothing", () => {
    const parent = makeStoreDir();
    const target = join(parent, "db");
    const error = refusal(() => preparePrivateFile(target, WINDOWS_LIKE));
    expect(error.code).toBe("unsupported_platform");
    expect(existsSync(target)).toBe(false);
  });

  it("refuses to tighten existing files instead of passing silently", () => {
    const parent = makeStoreDir();
    const error = refusal(() =>
      tightenPrivateFileIfPresent(join(parent, "missing"), WINDOWS_LIKE),
    );
    expect(error.code).toBe("unsupported_platform");
  });

  it("still enforces ownership checks when an identity is available", () => {
    const parent = makeStoreDir();
    const error = refusal(() =>
      preparePrivateDirectory(parent, {
        platform: "linux",
        getuid: () => (process.getuid?.() ?? 0) + 1,
      }),
    );
    expect(error.code).toBe("foreign_owner");
  });
});
