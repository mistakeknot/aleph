import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeMaintenanceFence } from "@bb/config/maintenance-fence";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { evaluateCliLaunchGuard } from "../launch-fence.js";

describe("evaluateCliLaunchGuard", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "aleph-cli-fence-"));
    mkdirSync(join(home, ".aleph"));
    mkdirSync(join(home, "code"));
    writeFileSync(
      join(home, "code", "package.json"),
      JSON.stringify({ name: "bb-app", version: "1.0.0" }),
    );
  });
  afterEach(() => {
    rmSync(home, { force: true, recursive: true });
  });

  it("allows a normal launch", () => {
    expect(
      evaluateCliLaunchGuard({
        env: { BB_DATA_DIR: join(home, ".aleph") },
        homeDir: home,
        fromDir: join(home, "code"),
      }),
    ).toBeNull();
  });

  it("refuses with exit code 75 while an update installs", () => {
    writeMaintenanceFence({
      dataDir: join(home, ".aleph"),
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
    const result = evaluateCliLaunchGuard({
      env: { BB_DATA_DIR: join(home, ".aleph") },
      homeDir: home,
      fromDir: join(home, "code"),
    });
    expect(result?.exitCode).toBe(75);
    expect(result?.message).toContain("Aleph is updating");
  });

  it("refuses a stock bb data dir", () => {
    const stock = join(home, ".bb");
    mkdirSync(stock);
    const result = evaluateCliLaunchGuard({
      env: { BB_DATA_DIR: stock },
      homeDir: home,
      fromDir: join(home, "code"),
    });
    expect(result?.exitCode).toBe(1);
  });

  it("refuses an older binary that presents the target version in its environment", () => {
    const result = evaluateCliLaunchGuard({
      env: { BB_APP_VERSION: "2.0.0", BB_DATA_DIR: join(home, ".aleph") },
      homeDir: home,
      fromDir: join(home, "code"),
    });
    expect(result?.exitCode).toBe(1);
    expect(result?.message).toContain("does not match");
  });
});
