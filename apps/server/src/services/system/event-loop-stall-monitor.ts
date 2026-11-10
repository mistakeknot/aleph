import {
  startEventLoopDelaySampler,
  startGcWindowObserver,
  takeHeapSummary,
} from "@bb/process-utils";
import type { GcWindow, HeapSummary } from "@bb/process-utils";
import type { ServerLogger } from "../../types.js";
import { takeEventLoopWorkWindowSnapshot } from "./event-loop-work.js";

export interface EventLoopStallMonitorOptions {
  logger: Pick<ServerLogger, "info">;
  now?: () => number;
  thresholdMs?: number | (() => number);
  gcWindow?: GcWindow;
  heapSummary?: () => HeapSummary;
}

export interface EventLoopStallMonitor {
  stop: () => void;
}

export function startEventLoopStallMonitor(
  options: EventLoopStallMonitorOptions,
): EventLoopStallMonitor {
  const gcWindow = options.gcWindow ?? startGcWindowObserver();
  const heapSummary = options.heapSummary ?? takeHeapSummary;
  const sampler = startEventLoopDelaySampler({
    now: options.now,
    thresholdMs: options.thresholdMs,
    onSample: ({ stall }) => {
      const work = takeEventLoopWorkWindowSnapshot();
      const gc = gcWindow.take();
      if (stall !== null) {
        const hasCandidate =
          work.longestSynchronousWorkWallMs !== null &&
          work.longestSynchronousWorkWallMs + stall.resolutionMs >=
            stall.maxDelayMs;
        options.logger.info(
          {
            ...stall,
            ...work,
            stallAttribution: hasCandidate ? "candidate" : "unattributed",
            stallCauseCandidate: hasCandidate
              ? work.longestSynchronousWork
              : null,
            ...gc,
            stallGcCandidate:
              gc.gcMaxDurationMs + stall.resolutionMs >= stall.maxDelayMs,
            heap: heapSummary(),
          },
          "Event loop stalled",
        );
      }
    },
  });
  return {
    stop: () => {
      sampler.stop();
      if (options.gcWindow === undefined) gcWindow.stop();
    },
  };
}
