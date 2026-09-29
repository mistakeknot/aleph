import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MaintenanceFenceRefusedError,
  registerFenceIdentity,
  resetFenceIdentityForTests,
  writeMaintenanceFence,
  type MaintenanceFence,
} from "@bb/config/maintenance-fence";
import { createConnection } from "../src/connection.js";

function fence(state: MaintenanceFence["state"]): MaintenanceFence {
  return {
    created_at: "2026-09-28T00:00:00.000Z",
    enrolled_path: "/Applications/Aleph.app",
    from_bundle_version: "1",
    from_cdhash: "a",
    from_tree_sha256: "b",
    from_version: "1.0.0",
    nonce: "n",
    observation: null,
    predecessor_path: "/tmp/pred",
    state,
    to_bundle_version: "2",
    to_cdhash: "c",
    to_tree_sha256: "d",
    to_version: "2.0.0",
  };
}

describe("createConnection maintenance fence", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "aleph-db-fence-"));
    resetFenceIdentityForTests();
  });
  afterEach(() => {
    resetFenceIdentityForTests();
    rmSync(dir, { force: true, recursive: true });
  });

  it("opens the database when no fence exists", () => {
    createConnection(join(dir, "bb.db")).$client.close();
  });

  it("refuses when a fence exists and no identity was registered", () => {
    writeMaintenanceFence({ dataDir: dir, fence: fence("probation") });
    expect(() => createConnection(join(dir, "bb.db"))).toThrow(
      MaintenanceFenceRefusedError,
    );
  });

  it("refuses a registered from_version process during probation", () => {
    writeMaintenanceFence({ dataDir: dir, fence: fence("probation") });
    registerFenceIdentity({ role: "embedded-server", version: "1.0.0" });
    expect(() => createConnection(join(dir, "bb.db"))).toThrow(
      MaintenanceFenceRefusedError,
    );
  });

  it("allows a registered to_version server during probation", () => {
    writeMaintenanceFence({ dataDir: dir, fence: fence("probation") });
    registerFenceIdentity({ role: "embedded-server", version: "2.0.0" });
    createConnection(join(dir, "bb.db")).$client.close();
  });

  it("ignores in-memory databases", () => {
    writeMaintenanceFence({ dataDir: dir, fence: fence("recovering") });
    createConnection(":memory:").$client.close();
  });
});
