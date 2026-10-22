import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { prependOlderTimelineRows } from "@bb/client-core";
import { getLatestThreadSequence } from "@bb/db";
import { encodeClientTurnRequestIdNumber } from "@bb/domain";
import type {
  TimelinePaginationCursor,
  TimelineRow,
} from "@bb/server-contract";
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

function commandItem(
  turnId: string,
  id: string,
  deltas: number,
  command = `rg pattern ${id}`,
): RowSpec[] {
  const item = {
    approvalStatus: null,
    command,
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

function workRows(
  turnId: string,
  events: number,
  prefix = turnId,
): RowSpec[] {
  const rows: RowSpec[] = [];
  let item = 0;
  while (rows.length < events) {
    item += 1;
    rows.push(
      ...(item % 3 === 0
        ? messageItem(turnId, `${prefix}-message-${item}`, 30)
        : commandItem(turnId, `${prefix}-command-${item}`, 20)),
    );
  }
  return rows;
}

function seedGiantTurn(
  completed: boolean,
  events = GIANT_TURN_EVENTS,
  work = workRows("turn-2", events),
): RowSpec[] {
  const rows: RowSpec[] = [
    ...turnOpening(1),
    ...workRows("turn-1", 200),
    { data: { status: "completed" }, turnId: "turn-1", type: "turn/completed" },
    ...turnOpening(2),
    ...work,
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
  // The walked pages merged the way the client merges them, beside one
  // unbudgeted read of the whole thread.
  merged: { full: TimelineRow[]; walked: TimelineRow[] };
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
    let walked: TimelineRow[] = [];
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
      walked = prependOlderTimelineRows({
        loadedRows: walked,
        olderRows: built.response.rows,
      });
      cursor = built.response.timelinePage.olderCursor;
      if (cursor === null || pages.length >= MAX_PAGES) break;
    }
    const full = buildRouteTimelinePage({
      db: testThread.db,
      eventBudget: 10_000_000,
      page: { kind: "latest", segmentLimit: 100_000 },
      registry,
      thread: testThread.thread,
      variant: "default",
    }).response.rows;
    result = {
      latest: pages[0]!,
      merged: { full, walked },
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
  const { merged: _merged, ...measured } = walked;
  const line = `${label} ${JSON.stringify(measured)}`;
  console.log(line);
  const out = process.env.TIMELINE_BENCH_OUT;
  if (out !== undefined) fs.appendFileSync(out, `${line}\n`);
}

describe("one giant turn", () => {
  it("bounds the rows a latest build reads while the turn runs", () => {
    const walked = walkGiantTurn(false);
    report("GIANT_TURN_RUNNING", walked);
    expect(walked.pages).toBeLessThan(MAX_PAGES);
    expect(walked.merged.walked).toEqual(walked.merged.full);
    expect(walked.latest.rows).toBeGreaterThan(0);
    expect(walked.maxEventRowCount).toBeLessThan(GIANT_TURN_EVENTS / 20);
  }, 600_000);

  it("walks a completed giant turn to the start", () => {
    const walked = walkGiantTurn(true);
    report("GIANT_TURN_COMPLETED", walked);
    expect(walked.pages).toBeLessThan(MAX_PAGES);
    expect(walked.merged.walked).toEqual(walked.merged.full);
    expect(walked.latest.rows).toBeGreaterThan(0);
    expect(walked.maxEventRowCount).toBeLessThan(2_000);
  }, 600_000);

  function expectTailMatchesFullRead(
    work: RowSpec[],
    expectBounded: boolean,
  ): void {
    withTestThread((testThread) => {
      appendRows(testThread, seedGiantTurn(true, work.length, work));
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
      if (expectBounded) {
        expect(bounded.profile.eventRowCount).toBeLessThan(
          full.profile.eventRowCount / 2,
        );
      }
      const boundedRows = bounded.response.rows;
      expect(boundedRows.length).toBeGreaterThan(0);
      expect(boundedRows).toEqual(
        full.response.rows.slice(-boundedRows.length),
      );
    });
  }

  it("keeps a sent message from the middle of a completed turn", () => {
    expectTailMatchesFullRead(
      [
        ...workRows("turn-2", 2_500),
        ...commandItem(
          "turn-2",
          "turn-2-send",
          1,
          'bb thread tell thr_wrkr234567 "status"',
        ),
        ...workRows("turn-2", 2_500, "turn-2-after"),
      ],
      false,
    );
  }, 600_000);

  const send = 'bb thread tell thr_wrkr234567 "status"';

  it("keeps a send that is the first item of a completed turn", () => {
    expectTailMatchesFullRead(
      [
        ...commandItem("turn-2", "turn-2-first-send", 1, send),
        ...workRows("turn-2", 5_000),
        ...commandItem("turn-2", "turn-2-lead-in", 2),
        ...messageItem("turn-2", "turn-2-final", 5),
      ],
      false,
    );
  }, 600_000);

  it("keeps a first-item send that overlaps the next command", () => {
    const first = commandItem("turn-2", "turn-2-overlap-send", 1, send);
    const next = commandItem("turn-2", "turn-2-overlap-next", 1);
    expectTailMatchesFullRead(
      [
        first[0]!,
        next[0]!,
        ...first.slice(1),
        ...next.slice(1),
        ...workRows("turn-2", 5_000),
        ...commandItem("turn-2", "turn-2-lead-in", 2),
        ...messageItem("turn-2", "turn-2-final", 5),
      ],
      false,
    );
  }, 600_000);

  it("keeps a send that leads in to the final message", () => {
    expectTailMatchesFullRead(
      [
        ...workRows("turn-2", 5_000),
        ...commandItem("turn-2", "turn-2-lead-in-send", 1, send),
        ...messageItem("turn-2", "turn-2-final", 5),
      ],
      false,
    );
  }, 600_000);

  it("counts a command that completes without a start", () => {
    expectTailMatchesFullRead(
      [
        ...workRows("turn-2", 2_500),
        commandItem("turn-2", "turn-2-completion-only", 1).at(-1)!,
        ...workRows("turn-2", 2_500, "turn-2-after"),
      ],
      false,
    );
  }, 600_000);

  it("does not count or end on agent messages without text", () => {
    expectTailMatchesFullRead(
      [
        ...workRows("turn-2", 5_000),
        ...commandItem("turn-2", "turn-2-before-empty-middle", 2),
        ...messageItem("turn-2", "turn-2-empty-middle", 0),
        ...commandItem("turn-2", "turn-2-before-visible", 2),
        ...messageItem("turn-2", "turn-2-visible", 5),
        ...commandItem("turn-2", "turn-2-before-empty", 2),
        ...messageItem("turn-2", "turn-2-empty-final", 0),
      ],
      false,
    );
  }, 600_000);

  it("falls back on agent message text that has no start", () => {
    const deltaOnly = messageItem("turn-2", "turn-2-delta-only", 3);
    expectTailMatchesFullRead(
      [
        ...workRows("turn-2", 2_500),
        ...deltaOnly.slice(1, -1),
        ...workRows("turn-2", 2_500, "turn-2-after"),
        ...commandItem("turn-2", "turn-2-lead-in", 2),
        ...messageItem("turn-2", "turn-2-final", 5),
      ],
      false,
    );
  }, 600_000);

  it("places a message by its first text, not its start", () => {
    // The final message starts before a command but its text arrives after
    // the command starts, so the projection shows the command first.
    const message = messageItem("turn-2", "turn-2-final", 3);
    const command = commandItem("turn-2", "turn-2-overtaking", 2);
    expectTailMatchesFullRead(
      [
        ...workRows("turn-2", 5_000),
        ...commandItem("turn-2", "turn-2-lead-in", 2),
        message[0]!,
        command[0]!,
        ...message.slice(1),
        ...command.slice(1),
      ],
      false,
    );
  }, 600_000);

  it("places a message by its first nonempty text", () => {
    // An empty delta before the command starts does not place the message;
    // the projection ignores it and places the message at its later text.
    const message = messageItem("turn-2", "turn-2-final", 3);
    const command = commandItem("turn-2", "turn-2-overtaking", 2);
    expectTailMatchesFullRead(
      [
        ...workRows("turn-2", 5_000),
        ...commandItem("turn-2", "turn-2-lead-in", 2),
        message[0]!,
        {
          data: { itemId: "turn-2-final", delta: "" },
          itemId: "turn-2-final",
          turnId: "turn-2",
          type: "item/agentMessage/delta",
        },
        command[0]!,
        ...message.slice(1),
        ...command.slice(1),
      ],
      false,
    );
  }, 600_000);

  it("places a command by output that arrives before its start", () => {
    // The command's output arrives before the final message's text, so the
    // projection moves the command ahead of the message it starts after.
    const message = messageItem("turn-2", "turn-2-final", 3);
    const command = commandItem("turn-2", "turn-2-early-output", 2);
    expectTailMatchesFullRead(
      [
        ...workRows("turn-2", 5_000),
        ...commandItem("turn-2", "turn-2-lead-in", 2),
        message[0]!,
        command[1]!,
        ...message.slice(1),
        command[0]!,
        ...command.slice(2),
      ],
      false,
    );
  }, 600_000);

  it("keeps the model fallback of a pinned snapshot", () => {
    withTestThread((testThread) => {
      appendRows(
        testThread,
        seedGiantTurn(false, 5_000, [
          {
            data: {
              fallbackModel: "gpt-5-mini",
              message: "Switched from gpt-5 to gpt-5-mini.",
              originalModel: "gpt-5",
              reason: "provider",
            },
            turnId: "turn-2",
            type: "provider/modelFallback",
          },
          ...workRows("turn-2", 5_000),
        ]),
      );
      const maxSeq = getLatestThreadSequence(testThread.db, {
        threadId: testThread.thread.id,
      });
      const build = (eventBudget?: number) =>
        buildRouteTimelinePage({
          db: testThread.db,
          eventBudget,
          maxSeq,
          page: { kind: "latest", segmentLimit: 3 },
          registry,
          thread: testThread.thread,
          variant: "default",
        });
      const expectSnapshotFallback = () => {
        const bounded = build();
        const full = build(1_000_000);
        expect(bounded.profile.eventRowCount).toBeLessThan(
          full.profile.eventRowCount / 2,
        );
        expect(full.response.modelFallback?.fallbackModel).toBe("gpt-5-mini");
        expect(bounded.response.modelFallback).toEqual(
          full.response.modelFallback,
        );
      };
      expectSnapshotFallback();

      // A newer fallback after the snapshot does not replace its fallback.
      appendRows(testThread, [
        {
          data: {
            fallbackModel: "gpt-5-nano",
            message: "Switched from gpt-5-mini to gpt-5-nano.",
            originalModel: "gpt-5-mini",
            reason: "provider",
          },
          turnId: "turn-2",
          type: "provider/modelFallback",
        },
      ]);
      expectSnapshotFallback();

      // Nor does a request after the snapshot clear it.
      appendRows(testThread, [
        { data: { status: "completed" }, turnId: "turn-2", type: "turn/completed" },
        ...turnOpening(3),
      ]);
      expectSnapshotFallback();
    });
  }, 600_000);

  it("keeps an early model fallback when a running turn is capped", () => {
    withTestThread((testThread) => {
      appendRows(
        testThread,
        seedGiantTurn(false, 5_000, [
          {
            data: {
              fallbackModel: "gpt-5-mini",
              message: "Switched from gpt-5 to gpt-5-mini.",
              originalModel: "gpt-5",
              reason: "provider",
            },
            turnId: "turn-2",
            type: "provider/modelFallback",
          },
          ...workRows("turn-2", 5_000),
        ]),
      );
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
      expect(full.response.modelFallback?.fallbackModel).toBe("gpt-5-mini");
      expect(bounded.response.modelFallback).toEqual(
        full.response.modelFallback,
      );

      appendRows(testThread, [
        { data: { status: "completed" }, turnId: "turn-2", type: "turn/completed" },
        ...turnOpening(3),
      ]);
      expect(build().response.modelFallback).toBeNull();
      expect(build(1_000_000).response.modelFallback).toBeNull();
    });
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
