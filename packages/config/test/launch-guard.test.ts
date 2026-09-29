import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AlephDataDirRefusedError } from "../src/aleph-data-dir.js";
import { runLaunchGuard } from "../src/launch-guard.js";
import {
  FENCE_REFUSED_EXIT_CODE,
  MaintenanceFenceRefusedError,
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
