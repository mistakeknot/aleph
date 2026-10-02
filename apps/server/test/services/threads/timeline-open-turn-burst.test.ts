import { describe, expect, it } from "vitest";
import { encodeClientTurnRequestIdNumber } from "@bb/domain";
import { createTestProviderRegistry } from "../../helpers/provider-registry.js";
import {
  appendRows,
  withTestThread,
  type RowSpec,
} from "../../helpers/timeline-cache-fixture.js";
import { getLatestThreadSequence } from "@bb/db";
import { createTimelineBuildCoalescer } from "../../../src/services/threads/timeline-build-coalescer.js";
import {
  buildRouteTimelinePage,
  selectionWasReused,
  type BuiltTimelinePage,
} from "../../provider-corpus/corpus-harness.js";

const registry = await createTestProviderRegistry();
const TURN = "turn-1";
const SEED_EVENTS = 10_000;
const MIXED_APPENDS = 200;

const execution = {
  model: "gpt-5",
  serviceTier: "default",
  reasoningLevel: "medium",
  permissionMode: "full",
  source: "client/turn/requested",
};

function seedRows(): RowSpec[] {
  const rows: RowSpec[] = [
    {
      data: {
        direction: "outbound",
        source: "tell",
        initiator: "user",
        request: { method: "turn/start", params: {} },
        requestId: encodeClientTurnRequestIdNumber({ value: 1 }),
        senderThreadId: null,
        input: [{ type: "text", text: "go", mentions: [] }],
        target: { kind: "thread-start" },
        execution,
      },
      type: "client/turn/requested",
    },
    { data: {}, turnId: TURN, type: "turn/started" },
    {
      data: { clientRequestId: encodeClientTurnRequestIdNumber({ value: 1 }) },
      turnId: TURN,
      type: "turn/input/accepted",
    },
  ];
  let item = 0;
  while (rows.length < SEED_EVENTS) {
    item += 1;
    const id = `seed-message-${item}`;
    rows.push(messageStarted(id));
    for (let index = 0; index < 40 && rows.length < SEED_EVENTS; index += 1) {
      rows.push(messageDelta(id, `chunk ${index} of ${id}\n`));
    }
  }
  return rows;
}

function messageStarted(id: string): RowSpec {
  return {
    data: { item: { id, text: "", type: "agentMessage" } },
    itemId: id,
    itemKind: "agentMessage",
    turnId: TURN,
    type: "item/started",
  };
}

function messageDelta(id: string, delta: string): RowSpec {
  return {
    data: { itemId: id, delta },
    itemId: id,
    turnId: TURN,
    type: "item/agentMessage/delta",
  };
}

function commandRow(
  type: "item/started" | "item/completed",
  id: string,
): RowSpec {
  return {
    data: {
      item: {
        approvalStatus: null,
        command: "ls",
        cwd: "/tmp/memo",
        id,
        status: type === "item/started" ? "pending" : "completed",
        type: "commandExecution",
        ...(type === "item/completed" ? { exitCode: 0, output: "ok\n" } : {}),
      },
    },
    itemId: id,
    itemKind: "commandExecution",
    turnId: TURN,
    type,
  };
}

function commandOutputDelta(id: string): RowSpec {
  return {
    data: { itemId: id, delta: "line\n" },
    itemId: id,
    turnId: TURN,
    type: "item/commandExecution/outputDelta",
  };
}

function mixedAppend(step: number): RowSpec[] {
  const id = `live-command-${Math.floor(step / 4)}`;
  switch (step % 4) {
    case 0:
      return [commandRow("item/started", id)];
    case 1:
      return [commandOutputDelta(id)];
    case 2:
      return [commandRow("item/completed", id)];
    default:
      return [messageDelta("seed-message-1", `live ${step}\n`)];
  }
}

function stageMs(
  stageTimings: readonly { durationMs: number; stage: string }[],
  stages: readonly string[],
): number {
  return stageTimings
    .filter((timing) => stages.includes(timing.stage))
    .reduce((sum, timing) => sum + timing.durationMs, 0);
}

interface BurstResult {
  builds: number;
  decodeMs: number;
  eventRowCountFirst: number;
  fullRebuilds: number;
  maxBuildMs: number;
  projectionMs: number;
  served: number;
  staleServed: number;
  totalBuildMs: number;
}

const APPEND_INTERVAL_MS = 10;

function runBurst(coalesce: boolean): BurstResult {
  const result: BurstResult = {
    builds: 0,
    decodeMs: 0,
    eventRowCountFirst: 0,
    fullRebuilds: 0,
    maxBuildMs: 0,
    projectionMs: 0,
    served: 0,
    staleServed: 0,
    totalBuildMs: 0,
  };
  withTestThread((testThread) => {
    appendRows(testThread, seedRows());
    let clock = 0;
    const coalescer = createTimelineBuildCoalescer({
      minBuildMs: 0,
      now: () => clock,
      onTrailingRefresh: () => undefined,
      schedule: () => () => undefined,
    });
    const buildArgs = {
      page: { kind: "latest", segmentLimit: 3 },
      registry,
      thread: testThread.thread,
      variant: "default",
    } as const;
    const serve = (): BuiltTimelinePage["response"] => {
      const maxSeq = getLatestThreadSequence(testThread.db, {
        threadId: testThread.thread.id,
      });
      return coalescer.serve({
        build: () => {
          const built = buildRouteTimelinePage({
            ...buildArgs,
            db: testThread.db,
          });
          result.builds += 1;
          if (result.builds === 1) {
            result.eventRowCountFirst = built.profile.eventRowCount;
          } else if (!selectionWasReused(built.profile)) {
            result.fullRebuilds += 1;
          }
          result.decodeMs += stageMs(built.profile.stageTimings, [
            "event-json-decode",
          ]);
          result.projectionMs += stageMs(built.profile.stageTimings, [
            "thread-view-projection",
          ]);
          result.totalBuildMs += built.profile.totalDurationMs;
          result.maxBuildMs = Math.max(
            result.maxBuildMs,
            built.profile.totalDurationMs,
          );
          clock += built.profile.totalDurationMs;
          return built.response;
        },
        coalesce,
        maxSeq,
        paramsKey: "latest",
        threadId: testThread.thread.id,
      }).response;
    };
    serve();
    for (let step = 0; step < MIXED_APPENDS; step += 1) {
      appendRows(testThread, mixedAppend(step));
      clock += APPEND_INTERVAL_MS;
      const response = serve();
      result.served += 1;
      if (
        response.maxSeq <
        getLatestThreadSequence(testThread.db, {
          threadId: testThread.thread.id,
        })
      ) {
        result.staleServed += 1;
      }
    }
    clock += 1_000;
    const settled = serve();
    const cold = buildRouteTimelinePage({
      ...buildArgs,
      db: testThread.coldDb,
    });
    expect(JSON.stringify(settled)).toBe(JSON.stringify(cold.response));
  });
  return result;
}

function summarize(result: BurstResult): Record<string, number> {
  return {
    builds: result.builds,
    decodeMs: Math.round(result.decodeMs),
    eventRowCountFirst: result.eventRowCountFirst,
    fullRebuilds: result.fullRebuilds,
    maxBuildMs: Math.round(result.maxBuildMs),
    projectionMs: Math.round(result.projectionMs),
    staleServed: result.staleServed,
    totalBuildMs: Math.round(result.totalBuildMs),
  };
}

describe("one large running turn under a mixed append burst", () => {
  it("reuses the selection for item lifecycle appends instead of rebuilding it", () => {
    const result = runBurst(false);
    console.log(`BURST_PER_APPEND ${JSON.stringify(summarize(result))}`);
    expect(result.eventRowCountFirst).toBeGreaterThan(9_000);
    expect(result.builds).toBe(MIXED_APPENDS + 1);
    expect(result.fullRebuilds).toBe(0);
    expect(result.staleServed).toBe(0);
  }, 600_000);

  it("coalesces latest builds to one per window and serves the last snapshot meanwhile", () => {
    const result = runBurst(true);
    console.log(`BURST_COALESCED ${JSON.stringify(summarize(result))}`);
    const burstMs = MIXED_APPENDS * APPEND_INTERVAL_MS + result.totalBuildMs;
    expect(result.fullRebuilds).toBe(0);
    expect(result.builds).toBeLessThanOrEqual(Math.ceil(burstMs / 250) + 2);
    expect(result.builds).toBeLessThan(MIXED_APPENDS / 4);
    expect(result.staleServed).toBeGreaterThan(MIXED_APPENDS / 2);
  }, 600_000);
});
