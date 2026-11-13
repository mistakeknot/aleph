import { turnScope, type ThreadEvent, type ThreadEventItem } from "@bb/domain";
import { describe, expect, it } from "vitest";
import { reduceWakeTurnOutcome } from "../../../src/services/threads/wake-turn-outcome.js";

const turnId = "turn-1";
const base = {
  threadId: "thread-1",
  providerThreadId: "provider-1",
  scope: turnScope(turnId),
};
const started: ThreadEvent = { ...base, type: "turn/started" };
const completed: ThreadEvent = {
  ...base,
  type: "turn/completed",
  status: "completed",
};
const response: ThreadEvent = {
  ...base,
  type: "item/completed",
  item: { type: "agentMessage", id: "response-1", text: "Done" },
};
const read: ThreadEventItem = {
  type: "fileRead",
  id: "read-1",
  path: "example.txt",
  status: "completed",
};
const write: ThreadEventItem = {
  type: "fileChange",
  id: "write-1",
  status: "completed",
  approvalStatus: null,
  changes: [
    { path: "example.txt", kind: "update", diff: "@@ -1 +1 @@\n-old\n+new\n" },
  ],
};
const shell: ThreadEventItem = {
  type: "commandExecution",
  id: "shell-1",
  command: "cat example.txt",
  cwd: "/tmp/example",
  status: "completed",
  approvalStatus: null,
  exitCode: 0,
};
const mcp: ThreadEventItem = {
  type: "toolCall",
  id: "mcp-1",
  server: "example.test",
  tool: "read_file",
  status: "completed",
};

function item(value: ThreadEventItem): ThreadEvent {
  return { ...base, type: "item/completed", item: value };
}

function reduce(
  events: ThreadEvent[],
  telemetry: "complete" | "unknown" = "complete",
) {
  return reduceWakeTurnOutcome({
    threadId: base.threadId,
    turnId,
    events,
    telemetry,
  });
}

describe("normalized wake turn effects", () => {
  it.each([
    {
      name: "headers only",
      diff: "--- a/example.txt\n+++ b/example.txt\n",
      changed: false,
    },
    {
      name: "removed dash-leading content",
      diff: "--- a/example.txt\n+++ b/example.txt\n@@ -1 +0,0 @@\n---leading-content\n",
      changed: true,
    },
    {
      name: "added plus-leading content",
      diff: "--- a/example.txt\n+++ b/example.txt\n@@ -0,0 +1 @@\n+++leading-content\n",
      changed: true,
    },
    {
      name: "removed header-like content inside a hunk",
      diff: "--- a/example.txt\n+++ b/example.txt\n@@ -1 +0,0 @@\n--- looks-like-a-header\n",
      changed: true,
    },
    {
      name: "added header-like content inside a hunk",
      diff: "--- a/example.txt\n+++ b/example.txt\n@@ -0,0 +1 @@\n+++ looks-like-a-header\n",
      changed: true,
    },
  ])("distinguishes diff headers from $name", ({ diff, changed }) => {
    const change: ThreadEventItem = {
      type: "fileChange",
      id: "diff-1",
      status: "completed",
      approvalStatus: null,
      changes: [{ path: "example.txt", kind: "update", diff }],
    };
    expect(reduce([started, item(change), completed])).toMatchObject({
      changedAnything: changed,
      effectKinds: changed ? ["file"] : [],
      toolCount: 1,
      coverage: { tools: "complete", effects: "complete" },
    });
  });

  it.each([
    {
      name: "no-tool response",
      items: [],
      changedAnything: false,
      effects: [],
      coverage: "complete",
    },
    {
      name: "structured read",
      items: [read],
      changedAnything: false,
      effects: [],
      coverage: "complete",
    },
    {
      name: "failed mutation",
      items: [{ ...write, status: "failed" }],
      changedAnything: false,
      effects: [],
      coverage: "complete",
    },
    {
      name: "actual successful diff",
      items: [write],
      changedAnything: true,
      effects: ["file"],
      coverage: "complete",
    },
    {
      name: "empty successful diff",
      items: [{ ...write, changes: [] }],
      changedAnything: false,
      effects: [],
      coverage: "complete",
    },
    {
      name: "write without a diff observation",
      items: [{ ...write, changes: [{ path: "example.txt", kind: "update" }] }],
      changedAnything: "unknown",
      effects: [],
      coverage: "partial",
    },
    {
      name: "read-looking shell",
      items: [shell],
      changedAnything: "unknown",
      effects: [],
      coverage: "partial",
    },
    {
      name: "read-looking MCP",
      items: [mcp],
      changedAnything: "unknown",
      effects: [],
      coverage: "partial",
    },
    {
      name: "read and opaque call",
      items: [read, mcp],
      changedAnything: "unknown",
      effects: [],
      coverage: "partial",
    },
    {
      name: "failed write and opaque call",
      items: [{ ...write, status: "failed" }, shell],
      changedAnything: "unknown",
      effects: [],
      coverage: "partial",
    },
    {
      name: "proven change wins mixed coverage",
      items: [write, shell],
      changedAnything: true,
      effects: ["file"],
      coverage: "partial",
    },
  ] satisfies {
    name: string;
    items: ThreadEventItem[];
    changedAnything: boolean | "unknown";
    effects: string[];
    coverage: string;
  }[])("$name", ({ items, changedAnything, effects, coverage }) => {
    expect(
      reduce([started, ...items.map(item), response, completed]),
    ).toMatchObject({
      changedAnything,
      effectKinds: effects,
      toolCount: items.length,
      coverage: { effects: coverage, tools: "complete" },
    });
  });

  it("counts unique top-level calls including failures, excluding progress and nested items", () => {
    const failed: ThreadEventItem = { ...write, status: "failed" };
    const stream: ThreadEvent[] = [
      started,
      { ...base, type: "item/started", item: { ...read, status: "pending" } },
      {
        ...base,
        type: "item/toolCall/progress",
        itemId: read.id,
        message: "reading",
      },
      item(read),
      item(read),
      item(failed),
      item(failed),
      item({ ...write, id: "nested", parentToolCallId: "parent" }),
      response,
      completed,
      completed,
    ];
    expect(reduce(stream)).toMatchObject({
      toolCount: 2,
      changedAnything: false,
      effectKinds: [],
    });
    expect(reduce([...stream, ...stream])).toEqual(reduce(stream));
  });

  it("does not use a pending diff as proof of a completed mutation", () => {
    const pending: ThreadEvent = {
      ...base,
      type: "item/started",
      item: { ...write, status: "pending" },
    };
    expect(reduce([started, pending, completed])).toMatchObject({
      changedAnything: "unknown",
      coverage: { effects: "partial" },
    });
  });

  it("keeps absent telemetry and incomplete turns unknown with null counts", () => {
    expect(reduce([started, response, completed], "unknown")).toMatchObject({
      toolCount: null,
      changedAnything: "unknown",
      coverage: { tools: "unknown", effects: "unknown" },
    });
    expect(reduce([started, item(read)])).toMatchObject({
      toolCount: null,
      changedAnything: "unknown",
    });
    expect(
      reduce([started, { ...completed, status: "interrupted" }]),
    ).toMatchObject({
      toolCount: null,
      changedAnything: "unknown",
    });
  });

  it("retains proof of mutation even when other telemetry is absent", () => {
    expect(reduce([started, item(write), completed], "unknown")).toMatchObject({
      toolCount: null,
      changedAnything: true,
      effectKinds: ["file"],
    });
  });

  it("recomputes late completions and items and replays without process state", () => {
    const early = [started, item(read)];
    expect(reduce(early)).toMatchObject({
      changedAnything: "unknown",
      toolCount: null,
    });
    const sealed = [...early, response, completed];
    const before = reduce(sealed);
    const late = [...sealed, item(write)];
    expect(reduce(late)).toMatchObject({ changedAnything: true, toolCount: 2 });
    expect(reduce(structuredClone(late))).toEqual(reduce(late));
    expect(before).toMatchObject({ changedAnything: false, toolCount: 1 });
    expect(reduce(sealed)).toEqual(before);
  });

  it("does not attribute an unrelated turn's file change", () => {
    expect(
      reduce([
        started,
        { ...item(write), scope: turnScope("other-turn") },
        response,
        completed,
      ]),
    ).toMatchObject({
      changedAnything: false,
      toolCount: 0,
    });
  });

  it.each(["task", "card", "outbound_message"])(
    "requires a completed acknowledged %s effect with explicit turn context",
    (effectKind) => {
      const acknowledgement: ThreadEvent = {
        threadId: base.threadId,
        scope: turnScope(turnId),
        type: "system/operation",
        operation: "wake.effect.v1",
        operationId: "effect-1",
        status: "completed",
        message: "Effect acknowledged",
        metadata: { effectKind, changed: true },
      };
      expect(
        reduce([started, acknowledgement, response, completed]),
      ).toMatchObject({
        changedAnything: true,
        effectKinds: [effectKind],
        toolCount: 0,
      });
      for (const status of ["pending", "failed"]) {
        expect(
          reduce([
            started,
            { ...acknowledgement, status },
            response,
            completed,
          ]),
        ).toMatchObject({
          changedAnything: false,
          effectKinds: [],
        });
      }
      expect(
        reduce([
          started,
          { ...acknowledgement, metadata: { effectKind, changed: false } },
          completed,
        ]),
      ).toMatchObject({
        changedAnything: false,
        effectKinds: [],
      });
      expect(
        reduce([
          started,
          { ...acknowledgement, scope: turnScope("other-turn") },
          completed,
        ]),
      ).toMatchObject({
        changedAnything: false,
        effectKinds: [],
      });
    },
  );
});
