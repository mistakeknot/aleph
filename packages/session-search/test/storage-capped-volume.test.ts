import { afterAll, describe, expect, it } from "vitest";

import {
  planLinuxLoop,
  planMacosImage,
  privilegedUnavailableReason,
  rehearsalUnavailableReason,
  rehearsalWrapperArgs,
  runOnPrivilegedVolume,
  runOnRehearsalVolume,
  type VolumeRun,
} from "./support/capped-volume.js";

const MIB = 1024 * 1024;
const VOLUME = 12 * MIB;

interface EnospcResult {
  batches: number;
  lastCursor: string | null;
  refusal: { code: string } | null;
  refusedCursor: string | null;
  cursorAfterRefusal: string | null;
  rowsAfterRefusal: number;
  expectedRows: number;
  integrity: { ok: boolean };
  suspended: string | null;
  refusedAgain: string | null;
  resumedCommitted: boolean;
  resumedCursor: string | null;
  rowsAfterResume: number;
  integrityAfterResume: { ok: boolean };
}

interface VacuumResult {
  freeBeforeDelete: number;
  freeAfter: number;
  reclaimed: boolean;
  reachedLow: boolean;
  batches: number;
  integrity: { ok: boolean };
}

interface BumpResult {
  freeBefore: number;
  freeAfter: number;
  previousVersion: number;
  previousContentCount: number;
  version: number;
  rowsAfter: number;
  integrity: { ok: boolean };
}

const report: string[] = [];

afterAll(() => {
  if (report.length > 0) {
    process.stdout.write(`CAPACITY-REPORT\n${report.join("\n")}\n`);
  }
});

function record(label: string, outcome: VolumeRun): void {
  report.push(
    outcome.status === "ran"
      ? `${label}: ran on ${outcome.kind}`
      : `${label}: ${outcome.reason}`,
  );
}

function checkEnospc(result: EnospcResult): void {
  expect(result.batches).toBeGreaterThan(2);
  expect(result.refusal?.code).toBe("disk_full");
  expect(result.refusedCursor).toBe(result.lastCursor);
  expect(result.cursorAfterRefusal).toBe(result.lastCursor);
  expect(result.rowsAfterRefusal).toBe(result.expectedRows);
  expect(result.integrity.ok).toBe(true);
  expect(result.suspended).toBe("disk_full");
  expect(result.refusedAgain).toBe("suspended");
  expect(result.resumedCommitted).toBe(true);
  expect(result.resumedCursor).toBe("after");
  expect(result.rowsAfterResume).toBe(result.expectedRows + 1);
  expect(result.integrityAfterResume.ok).toBe(true);
}

function checkVacuum(result: VacuumResult): void {
  expect(result.reclaimed).toBe(true);
  expect(result.reachedLow).toBe(true);
  expect(result.batches).toBeGreaterThan(0);
  expect(result.freeAfter).toBeGreaterThan(result.freeBeforeDelete);
  expect(result.integrity.ok).toBe(true);
}

function checkBump(result: BumpResult): void {
  expect(result.previousVersion).toBe(1);
  expect(result.previousContentCount).toBe(96);
  expect(result.version).toBe(2);
  expect(result.rowsAfter).toBe(0);
  expect(result.freeAfter).toBeGreaterThan(result.freeBefore);
  expect(result.integrity.ok).toBe(true);
}

function ranResult<T>(outcome: VolumeRun): T {
  if (outcome.status !== "ran") throw new Error(outcome.reason);
  return outcome.result as T;
}

describe("capped-volume command plans", () => {
  const input = {
    imagePath: "/work/volume.img",
    mountPoint: "/work/mnt",
    sizeBytes: 16 * MIB,
  };

  it("plans a loop-mounted ext4 volume and its teardown on Linux", () => {
    const plan = planLinuxLoop(input);
    expect(plan.kind).toBe("privileged-loop-ext4");
    expect(plan.setup).toEqual([
      { command: "truncate", args: ["-s", "16M", "/work/volume.img"] },
      { command: "mkfs.ext4", args: ["-F", "-q", "/work/volume.img"] },
      {
        command: "mount",
        args: ["-o", "loop,nosuid,nodev", "/work/volume.img", "/work/mnt"],
      },
    ]);
    expect(plan.teardown).toEqual([
      { command: "umount", args: ["/work/mnt"] },
      { command: "rm", args: ["-f", "/work/volume.img"] },
    ]);
  });

  it("plans an hdiutil disk image and its teardown on macOS", () => {
    const plan = planMacosImage({ ...input, imagePath: "/work/volume.dmg" });
    expect(plan.kind).toBe("privileged-hdiutil");
    expect(plan.setup).toEqual([
      {
        command: "hdiutil",
        args: [
          "create",
          "-size",
          "16m",
          "-fs",
          "HFS+",
          "-volname",
          "sscapped",
          "-ov",
          "/work/volume.dmg",
        ],
      },
      {
        command: "hdiutil",
        args: [
          "attach",
          "/work/volume.dmg",
          "-mountpoint",
          "/work/mnt",
          "-nobrowse",
        ],
      },
    ]);
    expect(plan.teardown).toEqual([
      { command: "hdiutil", args: ["detach", "/work/mnt", "-force"] },
      { command: "rm", args: ["-f", "/work/volume.dmg"] },
    ]);
  });

  it("rejects sizes that are not whole MiB", () => {
    expect(() => planLinuxLoop({ ...input, sizeBytes: 1000 })).toThrow(
      RangeError,
    );
    expect(() => planMacosImage({ ...input, sizeBytes: 0 })).toThrow(
      RangeError,
    );
  });

  it("wraps the rehearsal child in an unprivileged mount namespace", () => {
    const wrapper = rehearsalWrapperArgs("/work/mnt", 8 * MIB, [
      "node",
      "x.ts",
    ]);
    expect(wrapper.command).toBe("unshare");
    expect(wrapper.args.slice(0, 3)).toEqual(["-Urm", "sh", "-c"]);
    expect(wrapper.args.slice(-4)).toEqual(["/work/mnt", "8m", "node", "x.ts"]);
  });
});

describe("privileged capped volume (loop ext4 on Linux, hdiutil on macOS)", () => {
  const missing = privilegedUnavailableReason();
  if (missing !== null) report.push(`privileged volume: ${missing}`);

  it.skipIf(missing !== null)(
    "rolls back a real ENOSPC batch with the cursor unchanged, then resumes",
    () => {
      const outcome = runOnPrivilegedVolume({
        scenario: "enospc",
        sizeBytes: VOLUME,
        scenarioOptions: { volumeBytes: VOLUME },
      });
      record("privileged enospc", outcome);
      checkEnospc(ranResult<EnospcResult>(outcome));
    },
  );

  it.skipIf(missing !== null)(
    "returns space to the volume after an incremental vacuum",
    () => {
      const outcome = runOnPrivilegedVolume({
        scenario: "vacuum",
        sizeBytes: VOLUME,
        scenarioOptions: { volumeBytes: VOLUME },
      });
      record("privileged vacuum", outcome);
      checkVacuum(ranResult<VacuumResult>(outcome));
    },
  );

  it.skipIf(missing !== null)(
    "returns space to the volume after a reset for a schema bump",
    () => {
      const outcome = runOnPrivilegedVolume({
        scenario: "schemaBump",
        sizeBytes: VOLUME,
        scenarioOptions: { volumeBytes: VOLUME },
      });
      record("privileged schema bump", outcome);
      checkBump(ranResult<BumpResult>(outcome));
    },
  );
});

describe("rehearsal on an unprivileged tmpfs mount namespace (not a privileged capacity run)", () => {
  const missing = rehearsalUnavailableReason();
  if (missing !== null) report.push(`rehearsal volume: ${missing}`);

  it.skipIf(missing !== null)(
    "rehearsal: rolls back a real ENOSPC batch with the cursor unchanged, then resumes",
    () => {
      const outcome = runOnRehearsalVolume({
        scenario: "enospc",
        sizeBytes: VOLUME,
        scenarioOptions: { volumeBytes: VOLUME },
      });
      record("rehearsal enospc", outcome);
      checkEnospc(ranResult<EnospcResult>(outcome));
    },
  );

  it.skipIf(missing !== null)(
    "rehearsal: returns space to the volume after an incremental vacuum",
    () => {
      const outcome = runOnRehearsalVolume({
        scenario: "vacuum",
        sizeBytes: VOLUME,
        scenarioOptions: { volumeBytes: VOLUME },
      });
      record("rehearsal vacuum", outcome);
      checkVacuum(ranResult<VacuumResult>(outcome));
    },
  );

  it.skipIf(missing !== null)(
    "rehearsal: returns space to the volume after a reset for a schema bump",
    () => {
      const outcome = runOnRehearsalVolume({
        scenario: "schemaBump",
        sizeBytes: VOLUME,
        scenarioOptions: { volumeBytes: VOLUME },
      });
      record("rehearsal schema bump", outcome);
      checkBump(ranResult<BumpResult>(outcome));
    },
  );
});
