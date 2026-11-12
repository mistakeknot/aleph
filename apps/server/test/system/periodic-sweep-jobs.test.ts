import { describe, expect, it, vi } from "vitest";
import { getThread, listSweepItemFailures, markThreadDeleted } from "@bb/db";
import {
  PERIODIC_SWEEP_JOBS,
  runPeriodicSweepJobs,
  runThreadLifecycleSweep,
} from "../../src/services/system/periodic-sweeps.js";
import {
  seedHost,
  seedProjectWithSource,
  seedThread,
} from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";
import { runThreadPurges } from "../helpers/thread-purges.js";

describe("periodic sweep jobs", () => {
  it("gives every job a unique name that matches the item sweep it runs", async () => {
    await withTestHarness(async (harness) => {
      const deps = {
        ...harness.deps,
        pluginSchedules: harness.pluginService,
        plugins: harness.pluginService,
      };
      expect(
        PERIODIC_SWEEP_JOBS.map((job) => job.sweep(deps, Date.now()).name),
      ).toEqual(PERIODIC_SWEEP_JOBS.map((job) => job.name));
      expect(new Set(PERIODIC_SWEEP_JOBS.map((job) => job.name)).size).toBe(
        PERIODIC_SWEEP_JOBS.length,
      );
    });
  });

  it("schedules the Aleph jobs and runs them without recording failures", async () => {
    const alephJobs = [
      "thread-event-pruning",
      "thread-event-cold-tier",
      "transfer-ledger-drain",
      "queued-message-auto-send",
    ];
    expect(
      alephJobs.filter(
        (name) => !PERIODIC_SWEEP_JOBS.some((job) => job.name === name),
      ),
    ).toEqual([]);
    await withTestHarness(async (harness) => {
      const deps = {
        ...harness.deps,
        pluginSchedules: harness.pluginService,
        plugins: harness.pluginService,
      };
      await runPeriodicSweepJobs(
        deps,
        PERIODIC_SWEEP_JOBS.filter((job) => alephJobs.includes(job.name)),
        Date.now(),
      );
      for (const name of alephJobs) {
        expect(listSweepItemFailures(harness.db, name)).toEqual([]);
      }
    });
  });

  it("finishes deleting other threads when one deleted thread's finalization throws", async () => {
    await withTestHarness(async (harness) => {
      const host = seedHost(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const broken = seedThread(harness.deps, { projectId: project.id });
      const healthy = seedThread(harness.deps, { projectId: project.id });
      for (const thread of [broken, healthy]) {
        markThreadDeleted(harness.db, harness.deps.hub, {
          threadId: thread.id,
        });
      }
      const close = vi
        .spyOn(harness.deps.terminalSessions, "closeDeletedThreadTerminals")
        .mockImplementation(({ threadId }) => {
          if (threadId === broken.id) throw new Error("terminal close failed");
        });

      await runThreadLifecycleSweep(harness.deps);
      close.mockRestore();
      await runThreadPurges(harness.deps);

      expect(getThread(harness.db, healthy.id)).toBeNull();
      expect(getThread(harness.db, broken.id)?.deletedAt).toEqual(
        expect.any(Number),
      );
      expect(
        listSweepItemFailures(harness.db, "deleted-thread-finalization"),
      ).toMatchObject([
        { attempts: 1, itemKey: broken.id, lastError: "terminal close failed" },
      ]);
    });
  });
});
