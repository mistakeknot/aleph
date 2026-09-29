import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { alephReleaseIdentity } from "../src/aleph-version.js";
import { AlephDataDirRefusedError } from "../src/aleph-data-dir.js";
import {
  LaunchVersionMismatchError,
  evaluateLaunchGuard,
  resolveLaunchVersion,
  runLaunchGuard,
} from "../src/launch-guard.js";
import {
  FENCE_REFUSED_EXIT_CODE,
  MaintenanceFenceRefusedError,
  type FenceProcessRole,
  resetFenceIdentityForTests,
  writeMaintenanceFence,
} from "../src/maintenance-fence.js";

describe("runLaunchGuard", () => {
  let home: string;
  let dataDir: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "aleph-guard-"));
    dataDir = join(home, ".aleph");
    mkdirSync(dataDir);
    resetFenceIdentityForTests();
  });
  afterEach(() => {
    resetFenceIdentityForTests();
    rmSync(home, { force: true, recursive: true });
  });

  it("passes for a clean data dir", () => {
    runLaunchGuard({ dataDir, homeDir: home, role: "cli", version: "1.0.0" });
  });

  it("refuses a data dir inside the stock bb dir", () => {
    const stock = join(home, ".bb");
    mkdirSync(stock);
    expect(() =>
      runLaunchGuard({
        dataDir: stock,
        homeDir: home,
        role: "cli",
        version: "1.0.0",
      }),
    ).toThrow(AlephDataDirRefusedError);
  });

  it("refuses under an installing fence with exit code 75", () => {
    writeMaintenanceFence({
      dataDir,
      fence: {
        created_at: "x",
        enrolled_path: "/Applications/Aleph.app",
        from_bundle_version: "1",
        from_cdhash: "a",
        from_tree_sha256: "b",
        from_version: "1.0.0",
        nonce: "n",
        observation: null,
        predecessor_path: "/p",
        state: "installing",
        to_bundle_version: "2",
        to_cdhash: "c",
        to_tree_sha256: "d",
        to_version: "2.0.0",
      },
    });
    let caught: unknown;
    try {
      runLaunchGuard({ dataDir, homeDir: home, role: "cli", version: "1.0.0" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(MaintenanceFenceRefusedError);
    expect(Reflect.get(caught as object, "exitCode")).toBe(
      FENCE_REFUSED_EXIT_CODE,
    );
  });
});

const installingFence = (fromVersion: string, toVersion: string) => ({
  created_at: "x",
  enrolled_path: "/Applications/Aleph.app",
  from_bundle_version: "1",
  from_cdhash: "a",
  from_tree_sha256: "b",
  from_version: fromVersion,
  nonce: "n",
  observation: null,
  predecessor_path: "/p",
  state: "installing" as const,
  to_bundle_version: "2",
  to_cdhash: "c",
  to_tree_sha256: "d",
  to_version: toVersion,
});

function snapshotTree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        out[`${path}/`] = "";
        walk(path);
      } else {
        out[path] = readFileSync(path, "utf8");
      }
    }
  };
  walk(root);
  return out;
}

describe("launch version identity", () => {
  let home: string;
  let dataDir: string;
  let codeDir: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "aleph-version-"));
    dataDir = join(home, ".aleph");
    codeDir = join(home, "code");
    mkdirSync(dataDir);
    mkdirSync(codeDir);
    resetFenceIdentityForTests();
  });
  afterEach(() => {
    resetFenceIdentityForTests();
    rmSync(home, { force: true, recursive: true });
  });

  function installCode(version: string): void {
    writeFileSync(
      join(codeDir, "package.json"),
      JSON.stringify({ name: "bb-app", version }),
    );
  }

  it("derives the version from the running code, not the environment", () => {
    installCode("1.0.0");
    expect(resolveLaunchVersion({}, codeDir)).toBe("1.0.0");
    expect(resolveLaunchVersion({ BB_APP_VERSION: "1.0.0" }, codeDir)).toBe(
      "1.0.0",
    );
  });

  it("rejects an environment version that contradicts the code", () => {
    installCode("1.0.0");
    expect(() =>
      resolveLaunchVersion({ BB_APP_VERSION: "2.0.0" }, codeDir),
    ).toThrow(LaunchVersionMismatchError);
  });

  it("refuses an older binary that presents the target version in its environment", () => {
    installCode("1.0.0");
    writeMaintenanceFence({
      dataDir,
      fence: installingFence("1.0.0", "2.0.0"),
    });
    const refusal = evaluateLaunchGuard({
      dataDir,
      env: { BB_APP_VERSION: "2.0.0" },
      fromDir: codeDir,
      homeDir: home,
      role: "embedded-server",
    });
    expect(refusal).not.toBeNull();
    expect(refusal?.message).toContain("does not match");
  });

  it("still refuses the older binary when the environment is honest", () => {
    installCode("1.0.0");
    writeMaintenanceFence({
      dataDir,
      fence: installingFence("1.0.0", "2.0.0"),
    });
    const refusal = evaluateLaunchGuard({
      dataDir,
      env: {},
      fromDir: codeDir,
      homeDir: home,
      role: "embedded-server",
    });
    expect(refusal?.exitCode).toBe(FENCE_REFUSED_EXIT_CODE);
  });

  it("leaves a fenced or stock data directory byte-identical when it refuses", () => {
    installCode("1.0.0");
    writeMaintenanceFence({
      dataDir,
      fence: installingFence("1.0.0", "2.0.0"),
    });
    const stock = join(home, ".bb");
    mkdirSync(stock);
    writeFileSync(join(stock, "keep.txt"), "stock");
    const beforeFenced = snapshotTree(dataDir);
    const beforeStock = snapshotTree(stock);
    expect(
      evaluateLaunchGuard({
        dataDir,
        env: {},
        fromDir: codeDir,
        homeDir: home,
        role: "bundled-daemon",
      }),
    ).not.toBeNull();
    expect(
      evaluateLaunchGuard({
        dataDir: stock,
        env: {},
        fromDir: codeDir,
        homeDir: home,
        role: "cli",
      }),
    ).not.toBeNull();
    expect(snapshotTree(dataDir)).toEqual(beforeFenced);
    expect(snapshotTree(stock)).toEqual(beforeStock);
  });
});

describe("shared release identity", () => {
  let home: string;
  let dataDir: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "aleph-identity-"));
    dataDir = join(home, ".aleph");
    mkdirSync(dataDir);
    resetFenceIdentityForTests();
  });
  afterEach(() => {
    resetFenceIdentityForTests();
    rmSync(home, { force: true, recursive: true });
  });

  it("maps legacy, plain and dev forms consistently", () => {
    expect(alephReleaseIdentity("0.44.0+aleph.0.5.0")).toBe("0.5.0");
    expect(alephReleaseIdentity("0.5.0")).toBe("0.5.0");
    expect(alephReleaseIdentity("0.0.0-dev")).toBe("0.0.0-dev");
    expect(alephReleaseIdentity("0.44.0")).toBe("0.44.0");
  });

  const decide = (version: string, role: FenceProcessRole) => {
    try {
      return runLaunchGuard({ dataDir, homeDir: home, role, version }).kind;
    } catch (error) {
      return error instanceof MaintenanceFenceRefusedError
        ? "refused"
        : "error";
    } finally {
      resetFenceIdentityForTests();
    }
  };

  it("admits every process form of the target release and refuses older ones", () => {
    writeMaintenanceFence({
      dataDir,
      fence: { ...installingFence("0.4.1", "0.5.0"), state: "probation" },
    });
    expect(decide("0.44.0+aleph.0.5.0", "embedded-server")).toBe("allow");
    expect(decide("0.44.0+aleph.0.5.0", "bundled-daemon")).toBe("allow");
    expect(decide("0.4.1", "embedded-server")).toBe("refused");
    expect(decide("0.4.0", "bundled-daemon")).toBe("refused");
    expect(decide("0.44.0+aleph.0.4.1", "embedded-server")).toBe("refused");
    expect(decide("0.0.0-dev", "embedded-server")).toBe("refused");
  });

  it("lets the plain desktop version advance an installing fence to the target", () => {
    writeMaintenanceFence({
      dataDir,
      fence: installingFence("0.4.1", "0.5.0"),
    });
    expect(decide("0.5.0", "desktop-main")).toBe("advance_to_probation");
    expect(decide("0.44.0+aleph.0.5.0", "desktop-main")).toBe(
      "advance_to_probation",
    );
    expect(decide("0.44.0+aleph.0.5.0", "cli")).toBe("refused");
  });

  it("treats a legacy and plain environment version as the same constraint", () => {
    const codeDir = join(home, "code");
    mkdirSync(codeDir);
    writeFileSync(
      join(codeDir, "package.json"),
      JSON.stringify({ name: "bb-app", version: "0.44.0+aleph.0.5.0" }),
    );
    expect(resolveLaunchVersion({ BB_APP_VERSION: "0.5.0" }, codeDir)).toBe(
      "0.44.0+aleph.0.5.0",
    );
    expect(() =>
      resolveLaunchVersion({ BB_APP_VERSION: "0.4.1" }, codeDir),
    ).toThrow(LaunchVersionMismatchError);
  });
});
