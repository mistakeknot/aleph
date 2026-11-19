import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import {
  applyThreadTimelineDelta,
  computeThreadTimelineDelta,
  isThreadTimelineDelta,
  type ThreadTimelineResponse,
  type TimelineRow,
  type TimelineCommandWorkRow,
} from "@bb/server-contract";
import { selectThreadTimelineResponse } from "../../../src/services/threads/timeline-response-selection.js";

function row(id: string, title = "t"): TimelineRow {
  return {
    id,
    kind: "system",
    threadId: "thr_x",
    turnId: null,
    sourceSeqStart: 1,
    sourceSeqEnd: 1,
    startedAt: 0,
    createdAt: 0,
    systemKind: "debug",
    title,
    detail: null,
    status: null,
  };
}

function timeline(
  rows: TimelineRow[],
  overrides: Partial<ThreadTimelineResponse> = {},
): ThreadTimelineResponse {
  return {
    rows,
    contextBoundarySeq: null,
    completedTurnDisplay: "flat",
    activePromptMode: null,
    activeThinking: null,
    activeWorkflows: [],
    activeBackgroundCommands: [],
    pendingTodos: null,
    extensionStates: {},
    providerCommands: null,
    sessionOptions: null,
    modelFallback: null,
    timelinePage: {
      returnedSegmentCount: 1,
      olderCursor: null,
      historySnapshot: "snapshot",
      olderRowsSourceSeqEnd: null,
    },
    maxSeq: 1,
    tag: "tag-1",
    ...overrides,
  };
}

function command(output: string): TimelineCommandWorkRow {
  return {
    id: "command",
    kind: "work",
    workKind: "command",
    threadId: "thr_x",
    turnId: "turn_x",
    sourceSeqStart: 1,
    sourceSeqEnd: 2,
    startedAt: 0,
    createdAt: 0,
    status: "completed",
    callId: "call",
    command: "echo result",
    description: "Command detail",
    cwd: null,
    source: null,
    output,
    exitCode: 0,
    completedAt: 1,
    approvalStatus: null,
    activityIntents: [],
  };
}

describe("timeline response selection", () => {
  const held = timeline(
    Array.from({ length: 40 }, (_, i) =>
      row(String(i), "retained é command detail ".repeat(20)),
    ),
  );
  const histories = [
    [
      "tiny",
      timeline([...held.rows.slice(0, -1), row("39", "updated")], {
        tag: "next",
        maxSeq: 2,
      }),
    ],
    [
      "verbose",
      timeline([command("command output é".repeat(100_000))], {
        tag: "next",
        maxSeq: 3,
      }),
    ],
    [
      "reordered",
      timeline([...held.rows].reverse(), { tag: "next", maxSeq: 4 }),
    ],
    [
      "replaced",
      timeline(
        held.rows.map((_, i) => row("new-" + i, "replacement")),
        { tag: "next", maxSeq: 5 },
      ),
    ],
  ] as const;

  it.each(histories)(
    "round trips %s and records bytes and construction time",
    (name, current) => {
      const fullStart = performance.now();
      const fullBytes = Buffer.byteLength(JSON.stringify(current), "utf8");
      const fullMs = performance.now() - fullStart;
      const deltaStart = performance.now();
      const delta = computeThreadTimelineDelta(held, current);
      const deltaBytes = Buffer.byteLength(JSON.stringify(delta), "utf8");
      const deltaMs = performance.now() - deltaStart;
      const selectionStart = performance.now();
      const selected = selectThreadTimelineResponse(held, current);
      const selectionMs = performance.now() - selectionStart;
      expect(applyThreadTimelineDelta(held, delta)).toEqual(current);
      expect(
        isThreadTimelineDelta(selected)
          ? applyThreadTimelineDelta(held, selected)
          : selected,
      ).toEqual(current);
      expect(
        applyThreadTimelineDelta({ ...held, tag: "wrong" }, delta),
      ).toBeNull();
      if (name === "tiny") expect(isThreadTimelineDelta(selected)).toBe(true);
      if (name === "verbose") expect(selected).toBe(current);
      if (name === "replaced") expect(selected).toBe(current);
      console.log(
        JSON.stringify({
          history: name,
          fullBytes,
          deltaBytes,
          fullMs,
          deltaMs,
          selectionMs,
          selected: isThreadTimelineDelta(selected) ? "delta" : "full",
        }),
      );
    },
  );

  it("counts UTF-8 bytes when comparing envelopes", () => {
    const current = timeline([row("new", "é".repeat(40))], { tag: "new" });
    const delta = computeThreadTimelineDelta(held, current);
    const selected = selectThreadTimelineResponse(held, current);
    expect(Buffer.byteLength(JSON.stringify(selected))).toBe(
      Math.min(
        Buffer.byteLength(JSON.stringify(delta)),
        Buffer.byteLength(JSON.stringify(current)),
      ),
    );
  });
});
