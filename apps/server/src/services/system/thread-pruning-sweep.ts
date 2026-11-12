import { performance } from "node:perf_hooks";
import {
  advanceThreadPruning,
  getNextThreadPruningPolicy,
  getDatabaseMaintenanceActivity,
  isDatabaseMaintenanceIdle,
  pickThreadPruningThread,
  type THREAD_PRUNING_POLICIES,
} from "@bb/db";
import type { AppDeps } from "../../types.js";
import { defineScanSweep, type ItemSweep } from "./item-sweep.js";

export interface ThreadPruningSweepLimits {
  busyBatchSize: number;
  elapsedBudgetMs: number;
  idleBatchSize: number;
  maxAdvances: number;
}

export const THREAD_PRUNING_SWEEP_LIMITS: ThreadPruningSweepLimits = {
  busyBatchSize: 64,
  elapsedBudgetMs: 50,
  idleBatchSize: 500,
  maxAdvances: 64,
};

interface ThreadPruningItem {
  policy: (typeof THREAD_PRUNING_POLICIES)[number];
  threadId: string;
}

function pruningItemKey(item: ThreadPruningItem): string {
  return `${item.policy}:${item.threadId}`;
}

export function threadPruningSweep(
  deps: Pick<AppDeps, "db" | "hub" | "logger">,
  overrides: Partial<ThreadPruningSweepLimits>,
): ItemSweep {
  const limits = { ...THREAD_PRUNING_SWEEP_LIMITS, ...overrides };
  const startedAt = performance.now();
  let advances = 0;
  const withinBudget = () =>
    advances < limits.maxAdvances &&
    performance.now() - startedAt < limits.elapsedBudgetMs;
  const finishedPolicies = new Set<string>();
  return defineScanSweep<ThreadPruningItem>({
    name: "thread-event-pruning",
    concurrency: 1,
    list: ({ excludedKeys }) => {
      const items: ThreadPruningItem[] = [];
      if (!withinBudget()) return items;
      const visited = new Set<string>(finishedPolicies);
      for (
        let policy = getNextThreadPruningPolicy(deps.db, visited);
        policy !== null;
        policy = getNextThreadPruningPolicy(deps.db, visited)
      ) {
        visited.add(policy);
        const prefix = `${policy}:`;
        const excludedThreadIds = new Set(
          [...excludedKeys]
            .filter((itemKey) => itemKey.startsWith(prefix))
            .map((itemKey) => itemKey.slice(prefix.length)),
        );
        const threadId = pickThreadPruningThread(deps.db, {
          excludedThreadIds,
          policy,
        });
        if (threadId === null) finishedPolicies.add(policy);
        else items.push({ policy, threadId });
      }
      return items;
    },
    key: pruningItemKey,
    process: async (item) => {
      while (withinBudget()) {
        const busy = !isDatabaseMaintenanceIdle(
          getDatabaseMaintenanceActivity(deps.db),
        );
        const advanceStartedAt = performance.now();
        const result = advanceThreadPruning(deps.db, {
          policy: item.policy,
          batchSize: busy ? limits.busyBatchSize : limits.idleBatchSize,
        });
        const advanceElapsedMs = performance.now() - advanceStartedAt;
        advances += 1;
        if (advanceElapsedMs >= 50)
          deps.logger.warn(
            { ...result, advanceElapsedMs, busy },
            "Slow thread pruning advance",
          );
        deps.logger.debug(
          { ...result, advanceElapsedMs, busy },
          "Thread pruning policy advanced",
        );
        if (result.threadId !== item.threadId || result.action !== "advanced")
          return;
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    },
  });
}
