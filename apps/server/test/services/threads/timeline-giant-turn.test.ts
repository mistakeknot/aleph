import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { encodeClientTurnRequestIdNumber } from "@bb/domain";
import type { TimelinePaginationCursor } from "@bb/server-contract";
import { createTestProviderRegistry } from "../../helpers/provider-registry.js";
import {
  appendRows,
  withTestThread,
  type RowSpec,
} from "../../helpers/timeline-cache-fixture.js";
import { buildRouteTimelinePage } from "../../provider-corpus/corpus-harness.js";

const registry = await createTestProviderRegistry();
const GIANT_TURN_EVENTS = 40_000;
const MAX_PAGES = 400;

const execution = {
  model: "gpt-5",
  serviceTier: "default",
  reasoningLevel: "medium",
  permissionMode: "full",
  source: "client/turn/requested",
};

function turnOpening(turn: number): RowSpec[] {
  const turnId = `turn-${turn}`;
  const requestId = encodeClientTurnRequestIdNumber({ value: turn });
  return [
    {
      data: {
        direction: "outbound",
        source: "tell",
        initiator: "user",
        request: { method: "turn/start", params: {} },
        requestId,
        senderThreadId: null,
        input: [{ type: "text", text: `message ${turn}`, mentions: [] }],
        target: turn === 1 ? { kind: "thread-start" } : { kind: "new-turn" },
        execution,
      },
      type: "client/turn/requested",
    },
    { data: {}, turnId, type: "turn/started" },
    {
      data: { clientRequestId: requestId },
      turnId,
      type: "turn/input/accepted",
    },
  ];
}

function commandItem(turnId: string, id: string, deltas: number): RowSpec[] {
  const item = {
    approvalStatus: null,
    command: `rg pattern ${id}`,
    cwd: "/tmp/memo",
    id,
    type: "commandExecution",
  };
  const rows: RowSpec[] = [
    {
      data: { item: { ...item, status: "pending" } },
      itemId: id,
      itemKind: "commandExecution",
      turnId,
      type: "item/started",
    },
  ];
  for (let index = 0; index < deltas; index += 1) {
    rows.push({
      data: { itemId: id, delta: `match ${index} in ${id}\n`.repeat(4) },
      itemId: id,
      turnId,
      type: "item/commandExecution/outputDelta",
    });
  }
  rows.push({
    data: {
      item: {
        ...item,
        aggregatedOutput: `match in ${id}\n`.repeat(deltas * 4),
        exitCode: 0,
        status: "completed",
      },
    },
    itemId: id,
    itemKind: "commandExecution",
    turnId,
    type: "item/completed",
  });
  return rows;
}

function messageItem(turnId: string, id: string, deltas: number): RowSpec[] {
  const rows: RowSpec[] = [
    {
      data: { item: { id, text: "", type: "agentMessage" } },
      itemId: id,
      itemKind: "agentMessage",
      turnId,
      type: "item/started",
    },
  ];
  let text = "";
  for (let index = 0; index < deltas; index += 1) {
    const delta = `word ${index} `;
    text += delta;
    rows.push({
      data: { itemId: id, delta },
      itemId: id,
      turnId,
      type: "item/agentMessage/delta",
    });
  }
  rows.push({
    data: { item: { id, text, type: "agentMessage" } },
    itemId: id,
    itemKind: "agentMessage",
    turnId,
    type: "item/completed",
  });
  return rows;
}

function workRows(turnId: string, events: number): RowSpec[] {
  const rows: RowSpec[] = [];
  let item = 0;
  while (rows.length < events) {
    item += 1;
    rows.push(
      ...(item % 3 === 0
        ? messageItem(turnId, `${turnId}-message-${item}`, 30)
        : commandItem(turnId, `${turnId}-command-${item}`, 20)),
    );
  }
  return rows;
}

function seedGiantTurn(
  completed: boolean,
  events = GIANT_TURN_EVENTS,
): RowSpec[] {
  const rows: RowSpec[] = [
    ...turnOpening(1),
    ...workRows("turn-1", 200),
    { data: { status: "completed" }, turnId: "turn-1", type: "turn/completed" },
    ...turnOpening(2),
    ...workRows("turn-2", events),
  ];
  if (completed) {
    rows.push({
      data: { status: "completed" },
      turnId: "turn-2",
      type: "turn/completed",
    });
  }
  return rows;
}

interface PageMeasure {
  decodedEventCount: number;
  eventRowCount: number;
  stages: Record<string, number>;
  groupContextMs: number;
  ms: number;
  responseBytes: number;
  rows: number;
  strategy: string;
}

interface WalkMeasure {
  latest: PageMeasure;
  maxEventRowCount: number;
  maxMs: number;
  maxResponseBytes: number;
  pageEventRowCounts: number[];
  pages: number;
  totalMs: number;
}

function measure(
  built: ReturnType<typeof buildRouteTimelinePage>,
): PageMeasure {
  const stages: Record<string, number> = {};
  for (const timing of built.profile.stageTimings) {
    stages[timing.stage] = Math.round(
      (stages[timing.stage] ?? 0) + timing.durationMs,
    );
  }
  return {
    decodedEventCount: built.profile.decodedEventCount,
    eventRowCount: built.profile.eventRowCount,
    stages,
    groupContextMs: Math.round(
      built.profile.stageTimings
        .filter((timing) => timing.stage === "group-context-query")
        .reduce((sum, timing) => sum + timing.durationMs, 0),
    ),
    ms: Math.round(built.profile.totalDurationMs),
    responseBytes: Buffer.byteLength(JSON.stringify(built.response.rows)),
    rows: built.response.rows.length,
    strategy: built.profile.selectionStrategy,
  };
}

function walkGiantTurn(completed: boolean): WalkMeasure {
  let result: WalkMeasure | null = null;
  withTestThread((testThread) => {
    appendRows(testThread, seedGiantTurn(completed));
    let cursor: TimelinePaginationCursor | null = null;
    const pages: PageMeasure[] = [];
    for (;;) {
      const built = buildRouteTimelinePage({
        db: testThread.db,
        page:
          cursor === null
            ? { kind: "latest", segmentLimit: 3 }
            : { kind: "older", beforeCursor: cursor, segmentLimit: 3 },
        registry,
        thread: testThread.thread,
        variant: "default",
      });
      pages.push(measure(built));
      cursor = built.response.timelinePage.olderCursor;
      if (cursor === null || pages.length >= MAX_PAGES) break;
    }
    result = {
      latest: pages[0]!,
      maxEventRowCount: Math.max(...pages.map((page) => page.eventRowCount)),
      maxMs: Math.max(...pages.map((page) => page.ms)),
      maxResponseBytes: Math.max(...pages.map((page) => page.responseBytes)),
      pageEventRowCounts: pages.map((page) => page.eventRowCount),
      pages: pages.length,
      totalMs: pages.reduce((sum, page) => sum + page.ms, 0),
    };
  });
  return result!;
}

function report(label: string, walked: WalkMeasure): void {
  const line = `${label} ${JSON.stringify(walked)}`;
  console.log(line);
  const out = process.env.TIMELINE_BENCH_OUT;
  if (out !== undefined) fs.appendFileSync(out, `${line}\n`);
}

describe("one giant turn", () => {
  it("bounds the rows a latest build reads while the turn runs", () => {
    const walked = walkGiantTurn(false);
    report("GIANT_TURN_RUNNING", walked);
    expect(walked.pages).toBeLessThan(MAX_PAGES);
    expect(walked.latest.rows).toBeGreaterThan(0);
    expect(walked.maxEventRowCount).toBeLessThan(GIANT_TURN_EVENTS / 20);
  }, 600_000);

  it("walks a completed giant turn to the start", () => {
    const walked = walkGiantTurn(true);
    report("GIANT_TURN_COMPLETED", walked);
    expect(walked.pages).toBeLessThan(MAX_PAGES);
    expect(walked.latest.rows).toBeGreaterThan(0);
    expect(walked.maxEventRowCount).toBeLessThan(2_000);
  }, 600_000);

  it("collapses a completed turn read from its tail like a full read", () => {
    withTestThread((testThread) => {
      appendRows(testThread, seedGiantTurn(true, 5_000));
      const build = (eventBudget?: number) =>
        buildRouteTimelinePage({
          db: testThread.db,
          eventBudget,
          page: { kind: "latest", segmentLimit: 3 },
          registry,
          thread: testThread.thread,
          variant: "default",
        });
      const bounded = build();
      const full = build(1_000_000);
      expect(bounded.profile.eventRowCount).toBeLessThan(
        full.profile.eventRowCount / 2,
      );
      const boundedRows = bounded.response.rows;
      expect(boundedRows.length).toBeGreaterThan(0);
      expect(boundedRows).toEqual(
        full.response.rows.slice(-boundedRows.length),
      );
    });
  }, 600_000);
});
