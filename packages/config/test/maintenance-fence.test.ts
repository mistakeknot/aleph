import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireDataDirLock } from "../src/data-dir-lock.js";
import { FileLockTimeoutError } from "../src/file-lock.js";
import {
  FENCE_REFUSED_EXIT_CODE,
  MaintenanceFenceRefusedError,
  advanceFenceToProbation,
  assertFenceAllowsDatabase,
  checkMaintenanceFence,
  formatMaintenanceFencePath,
  readMaintenanceFence,
  registerFenceIdentity,
  resetFenceIdentityForTests,
  writeMaintenanceFence,
  type FenceProcessRole,
  type MaintenanceFence,
  type MaintenanceFenceState,
} from "../src/maintenance-fence.js";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "aleph-fence-"));
  resetFenceIdentityForTests();
});

afterEach(() => {
  resetFenceIdentityForTests();
  rmSync(dataDir, { force: true, recursive: true });
});

function fenceIn(state: MaintenanceFenceState): MaintenanceFence {
  return {
    state,
    enrolled_path: "/Applications/Aleph.app",
    from_version: "0.5.0",
    to_version: "0.5.1",
    from_bundle_version: "50",
    to_bundle_version: "51",
    from_cdhash: "aa",
    to_cdhash: "bb",
    from_tree_sha256: "cc",
    to_tree_sha256: "dd",
    predecessor_path: "/x/predecessor",
    created_at: "2026-09-28T00:00:00.000Z",
    nonce: "n1",
    observation: null,
  };
}

const ROLES: FenceProcessRole[] = [
  "desktop-main",
  "embedded-server",
  "bundled-daemon",
  "cli",
  "plugin-worker",
];

describe("maintenance fence file", () => {
  it("is absent until written, and round-trips atomically", () => {
    expect(readMaintenanceFence(dataDir)).toEqual({ status: "absent" });
    writeMaintenanceFence({ dataDir, fence: fenceIn("installing") });
    expect(readMaintenanceFence(dataDir)).toEqual({
      fence: fenceIn("installing"),
      status: "present",
    });
    expect(readdirSync(dataDir).filter((n) => n.includes(".tmp"))).toEqual([]);
  });

  it("reports a tampered or unparseable fence as corrupt", () => {
    writeMaintenanceFence({ dataDir, fence: fenceIn("installing") });
    const path = formatMaintenanceFencePath(dataDir);
    const raw = readFileSync(path, "utf8");
    writeFileSync(path, raw.replace("installing", "probation"));
    expect(readMaintenanceFence(dataDir)).toMatchObject({ status: "corrupt" });
    writeFileSync(path, "{");
    expect(readMaintenanceFence(dataDir)).toMatchObject({ status: "corrupt" });
  });
});

describe("checkMaintenanceFence decision table (plan 7.4)", () => {
  it("allows everything when no fence exists", () => {
    for (const role of ROLES) {
      expect(
        checkMaintenanceFence({
          dataDir,
          identity: { role, version: "0.5.0" },
        }),
      ).toEqual({ kind: "allow" });
    }
  });

  it("installing: refuses every from_version role with exit 75 and lets only the to_version desktop advance", () => {
    writeMaintenanceFence({ dataDir, fence: fenceIn("installing") });
    for (const role of ROLES) {
      const decision = checkMaintenanceFence({
        dataDir,
        identity: { role, version: "0.5.0" },
      });
      expect(decision).toMatchObject({
        exitCode: FENCE_REFUSED_EXIT_CODE,
        kind: "refuse",
      });
      expect(decision.kind === "refuse" && decision.message).toContain(
        "Aleph is updating",
      );
    }
    expect(
      checkMaintenanceFence({
        dataDir,
        identity: { role: "desktop-main", version: "0.5.1" },
      }),
    ).toEqual({ kind: "advance_to_probation" });
    for (const role of ROLES.filter((r) => r !== "desktop-main")) {
      expect(
        checkMaintenanceFence({
          dataDir,
          identity: { role, version: "0.5.1" },
        }),
      ).toMatchObject({ kind: "refuse" });
    }
  });

  it("probation: refuses from_version, lets the to_version desktop and its bundled processes run, and asks other writers to retry", () => {
    writeMaintenanceFence({ dataDir, fence: fenceIn("probation") });
    for (const role of ROLES) {
      expect(
        checkMaintenanceFence({
          dataDir,
          identity: { role, version: "0.5.0" },
        }),
      ).toMatchObject({ kind: "refuse" });
    }
    for (const role of [
      "desktop-main",
      "embedded-server",
      "bundled-daemon",
      "plugin-worker",
    ] as const) {
      expect(
        checkMaintenanceFence({
          dataDir,
          identity: { role, version: "0.5.1" },
        }),
      ).toEqual({ kind: "allow" });
    }
    const cli = checkMaintenanceFence({
      dataDir,
      identity: { role: "cli", version: "0.5.1" },
    });
    expect(cli).toMatchObject({
      exitCode: 75,
      kind: "refuse",
      retryable: true,
    });
  });

  it("recovering: refuses every role and version", () => {
    writeMaintenanceFence({ dataDir, fence: fenceIn("recovering") });
    for (const role of ROLES) {
      for (const version of ["0.5.0", "0.5.1"]) {
        expect(
          checkMaintenanceFence({ dataDir, identity: { role, version } }),
        ).toMatchObject({ kind: "refuse" });
      }
    }
  });

  it("refuses a process matching neither version, telling old processes to reopen the enrolled app", () => {
    writeMaintenanceFence({ dataDir, fence: fenceIn("probation") });
    const decision = checkMaintenanceFence({
      dataDir,
      identity: { role: "desktop-main", version: "9.9.9" },
    });
    expect(decision.kind === "refuse" && decision.message).toContain(
      "/Applications/Aleph.app",
    );
  });

  it("fails closed on a corrupt fence for every role", () => {
    writeFileSync(formatMaintenanceFencePath(dataDir), "garbage");
    for (const role of ROLES) {
      expect(
        checkMaintenanceFence({
          dataDir,
          identity: { role, version: "0.5.1" },
        }),
      ).toMatchObject({ exitCode: 75, kind: "refuse" });
    }
  });
});

describe("advanceFenceToProbation", () => {
  it("moves installing to probation under the exclusive lock", async () => {
    writeMaintenanceFence({ dataDir, fence: fenceIn("installing") });
    await advanceFenceToProbation({
      dataDir,
      holder: { bundlePath: "/Applications/Aleph.app" },
      timeoutMs: 200,
    });
    expect(readMaintenanceFence(dataDir)).toMatchObject({
      fence: { nonce: "n1", state: "probation" },
      status: "present",
    });
  });

  it("does not change the fence while another writer holds the lock", async () => {
    writeMaintenanceFence({ dataDir, fence: fenceIn("installing") });
    const shared = await acquireDataDirLock({
      dataDir,
      holder: { bundlePath: "/x" },
      mode: "shared",
      timeoutMs: 100,
    });
    await expect(
      advanceFenceToProbation({
        dataDir,
        holder: { bundlePath: "/x" },
        timeoutMs: 100,
      }),
    ).rejects.toBeInstanceOf(FileLockTimeoutError);
    expect(readMaintenanceFence(dataDir)).toMatchObject({
      fence: { state: "installing" },
    });
    await shared.release();
  });

  it("refuses to advance a fence that is not installing", async () => {
    writeMaintenanceFence({ dataDir, fence: fenceIn("recovering") });
    await expect(
      advanceFenceToProbation({
        dataDir,
        holder: { bundlePath: "/x" },
        timeoutMs: 100,
      }),
    ).rejects.toThrow(/installing/u);
  });
});

describe("assertFenceAllowsDatabase (the DB-open backstop)", () => {
  const databasePath = (): string => join(dataDir, "bb.db");

  it("allows any process when no fence sits next to the database", () => {
    expect(() => assertFenceAllowsDatabase(databasePath())).not.toThrow();
    expect(() => assertFenceAllowsDatabase(":memory:")).not.toThrow();
  });

  it("refuses a process that never ran the fence check", () => {
    writeMaintenanceFence({ dataDir, fence: fenceIn("probation") });
    expect(() => assertFenceAllowsDatabase(databasePath())).toThrow(
      MaintenanceFenceRefusedError,
    );
  });

  it("follows the registered identity", () => {
    writeMaintenanceFence({ dataDir, fence: fenceIn("probation") });
    registerFenceIdentity({ role: "embedded-server", version: "0.5.1" });
    expect(() => assertFenceAllowsDatabase(databasePath())).not.toThrow();
    resetFenceIdentityForTests();
    registerFenceIdentity({ role: "embedded-server", version: "0.5.0" });
    expect(() => assertFenceAllowsDatabase(databasePath())).toThrow(
      MaintenanceFenceRefusedError,
    );
  });
});

describe("assertFenceAllowsDataDir", () => {
  it("refuses an unregistered process while a fence exists", async () => {
    const { assertFenceAllowsDataDir } =
      await import("../src/maintenance-fence.js");
    const dir = mkdtempSync(join(tmpdir(), "aleph-fence-dir-"));
    try {
      resetFenceIdentityForTests();
      expect(() => assertFenceAllowsDataDir(dir)).not.toThrow();
      writeMaintenanceFence({
        dataDir: dir,
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
          state: "probation",
          to_bundle_version: "2",
          to_cdhash: "c",
          to_tree_sha256: "d",
          to_version: "2.0.0",
        },
      });
      expect(() => assertFenceAllowsDataDir(dir)).toThrow(
        MaintenanceFenceRefusedError,
      );
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });
});
