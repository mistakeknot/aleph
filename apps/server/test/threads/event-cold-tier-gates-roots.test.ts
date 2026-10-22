import {
  advanceThreadPruning,
  bindEnvironmentPath,
  ColdThreadHistoryError,
  getEnvironment,
  reserveEnvironment,
} from "@bb/db";
import { describe, expect, it } from "vitest";
import { runThreadPruningSweep } from "../../src/services/system/thread-pruning-sweep.js";
import {
  countThreadEvents,
  forceColdStateRow,
  seedColdTierEvents,
} from "../helpers/cold-tier.js";
import {
  seedEnvironment,
  seedThreadFixture,
  seedThread,
} from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

let counter = 0;

function seedFixture(harness: TestAppHarness) {
  counter += 1;
  const fixture = seedThreadFixture(harness, {
    session: { id: `host-cold-roots-${counter}` },
    environment: { path: `/tmp/cold-roots-${counter}` },
  });
  seedColdTierEvents(harness.db, fixture.thread.id);
  return fixture;
}

describe("cold thread bound to an environment row", () => {
  it("reserveEnvironment reuse branch throws ColdThreadHistoryError and leaves the row unchanged", async () => {
    await withTestHarness(async (harness) => {
      const { environment, thread } = seedFixture(harness);
      harness.db.$client
        .prepare(
          "UPDATE environments SET status = 'destroyed', teardown_status = 'removed', owner_thread_id = ? WHERE id = ?",
        )
        .run(thread.id, environment.id);
      forceColdStateRow(harness.db, thread.id);
      const row = getEnvironment(harness.db, environment.id)!;
      const { id, createdAt, updatedAt, ...input } = row;
      void id;
      void createdAt;
      void updatedAt;

      expect(() =>
        reserveEnvironment(harness.db, { ...input, status: "provisioning" }),
      ).toThrow(ColdThreadHistoryError);

      const after = getEnvironment(harness.db, environment.id)!;
      expect(after.status).toBe("destroyed");
      expect(after.teardownStatus).toBe("removed");
      expect(after.updatedAt).toBe(row.updatedAt);
    });
  });

  it("reserveEnvironment reuse branch succeeds when the bound thread is hot", async () => {
    await withTestHarness(async (harness) => {
      const { environment, thread } = seedFixture(harness);
      harness.db.$client
        .prepare(
          "UPDATE environments SET status = 'destroyed', teardown_status = 'removed', owner_thread_id = ? WHERE id = ?",
        )
        .run(thread.id, environment.id);
      const row = getEnvironment(harness.db, environment.id)!;
      const { id, createdAt, updatedAt, ...input } = row;
      void createdAt;
      void updatedAt;

      const reused = reserveEnvironment(harness.db, {
        ...input,
        status: "provisioning",
      });
      expect(reused.id).toBe(id);
      expect(reused.teardownStatus).toBeNull();
    });
  });

  it("bindEnvironmentPath throws ColdThreadHistoryError when the matched workspace holds a cold thread", async () => {
    await withTestHarness(async (harness) => {
      const { environment, host, project, thread } = seedFixture(harness);
      const otherThread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: null,
      });
      const provisioning = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: null,
        status: "provisioning",
      });
      harness.db.$client
        .prepare("UPDATE environments SET owner_thread_id = ? WHERE id = ?")
        .run(otherThread.id, provisioning.id);
      forceColdStateRow(harness.db, thread.id);
      const current = getEnvironment(harness.db, provisioning.id)!;

      expect(() =>
        bindEnvironmentPath(harness.db, current, environment.path!),
      ).toThrow(ColdThreadHistoryError);
      expect(getEnvironment(harness.db, provisioning.id)!.path).toBeNull();
    });
  });

  it("bindEnvironmentPath does not throw the cold error when the bound thread is hot", async () => {
    await withTestHarness(async (harness) => {
      const { environment, host, project } = seedFixture(harness);
      const otherThread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: null,
      });
      const provisioning = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: null,
        status: "provisioning",
      });
      harness.db.$client
        .prepare("UPDATE environments SET owner_thread_id = ? WHERE id = ?")
        .run(otherThread.id, provisioning.id);
      const current = getEnvironment(harness.db, provisioning.id)!;

      let error: unknown = null;
      try {
        bindEnvironmentPath(harness.db, current, environment.path!);
      } catch (caught) {
        error = caught;
      }
      expect(error).not.toBeInstanceOf(ColdThreadHistoryError);
    });
  });
});

describe("thread pruning skips cold threads", () => {
  function seedWork(harness: TestAppHarness, threadId: string) {
    harness.db.$client
      .prepare(
        "INSERT OR REPLACE INTO thread_pruning_work (policy, thread_id, revision) VALUES (?, ?, 1)",
      )
      .run("turn-diffs", threadId);
  }

  function workCount(harness: TestAppHarness, threadId: string): number {
    return harness.db.$client
      .prepare<
        [string],
        { count: number }
      >("SELECT COUNT(*) AS count FROM thread_pruning_work WHERE thread_id = ?")
      .get(threadId)!.count;
  }

  it("a direct threadId advance defers a cold thread and removes nothing", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedFixture(harness);
      seedWork(harness, thread.id);
      forceColdStateRow(harness.db, thread.id);
      const before = countThreadEvents(harness.db, thread.id);

      const result = advanceThreadPruning(harness.db, { threadId: thread.id });

      expect(result.action).toBe("thread-deferred");
      expect(result.removed).toBe(0);
      expect(countThreadEvents(harness.db, thread.id)).toBe(before);
      expect(workCount(harness, thread.id)).toBeGreaterThan(0);
    });
  });

  it("the periodic sweep does not select a cold thread and keeps its pending work", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedFixture(harness);
      seedWork(harness, thread.id);
      forceColdStateRow(harness.db, thread.id);
      const before = countThreadEvents(harness.db, thread.id);

      await runThreadPruningSweep(harness.deps, {
        busyBatchSize: 64,
        elapsedBudgetMs: 1000,
        idleBatchSize: 500,
        maxAdvances: 64,
      });

      expect(countThreadEvents(harness.db, thread.id)).toBe(before);
      expect(workCount(harness, thread.id)).toBeGreaterThan(0);
      const cursors = harness.db.$client
        .prepare<
          [string],
          { current_thread_id: string | null }
        >("SELECT current_thread_id FROM thread_pruning_cursors WHERE current_thread_id = ?")
        .all(thread.id);
      expect(cursors).toEqual([]);
    });
  });
});
