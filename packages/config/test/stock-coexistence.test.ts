import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AlephDataDirRefusedError } from "../src/aleph-data-dir.js";
import {
  FENCE_PROCESS_ROLES,
  resetFenceIdentityForTests,
} from "../src/maintenance-fence.js";
import { runLaunchGuard } from "../src/launch-guard.js";

describe("stock bb coexistence", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "aleph-coexist-"));
    resetFenceIdentityForTests();
  });
  afterEach(() => {
    resetFenceIdentityForTests();
    rmSync(home, { force: true, recursive: true });
  });

  function reasonFor(
    dataDir: string,
    role: (typeof FENCE_PROCESS_ROLES)[number],
  ): unknown {
    try {
      runLaunchGuard({
        dataDir,
        homeDir: home,
        role,
        version: "0.44.0+aleph.0.5.0",
      });
    } catch (error) {
      if (error instanceof AlephDataDirRefusedError)
        return error.refusal.reason;
      throw error;
    }
    return null;
  }

  it("refuses a stock ~/.bb for every launch role", () => {
    const stock = join(home, ".bb");
    mkdirSync(stock);
    for (const role of FENCE_PROCESS_ROLES) {
      expect(reasonFor(stock, role)).toBe("inside_stock_bb_dir");
    }
  });

  it("refuses a BB_DATA_DIR symlinked into ~/.bb", () => {
    mkdirSync(join(home, ".bb"));
    const link = join(home, "elsewhere");
    symlinkSync(join(home, ".bb"), link);
    expect(reasonFor(link, "embedded-server")).toBe("inside_stock_bb_dir");
  });

  it("refuses a custom directory holding a stock database", () => {
    const dir = join(home, "custom");
    mkdirSync(dir);
    const database = new DatabaseSync(join(dir, "bb.db"));
    database.exec(
      "CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY, hash TEXT NOT NULL, created_at NUMERIC)",
    );
    database.exec(
      "INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('h', 1)",
    );
    database.close();
    expect(reasonFor(dir, "bundled-daemon")).toBe("stock_bb_database");
  });

  it("refuses a custom directory holding a stock runtime file", () => {
    const dir = join(home, "custom");
    mkdirSync(dir);
    writeFileSync(
      join(dir, "bb-app-runtime.json"),
      JSON.stringify({ version: "0.44.0", pid: 1 }),
    );
    expect(reasonFor(dir, "cli")).toBe("stock_bb_runtime_file");
  });

  it("lets Aleph run in ~/.aleph beside an existing stock ~/.bb", () => {
    mkdirSync(join(home, ".bb"));
    const dataDir = join(home, ".aleph");
    mkdirSync(dataDir);
    for (const role of FENCE_PROCESS_ROLES) {
      expect(reasonFor(dataDir, role)).toBeNull();
    }
  });
});
