import { describe, expect, it } from "vitest";
import {
  encodeClientTurnRequestIdNumber,
  threadScope,
  turnScope,
} from "@bb/domain";
import type { ClientTurnRequestId, Thread } from "@bb/domain";
import {
  createProject,
  createThread,
  insertEvents,
  noopNotifier,
  upsertHost,
} from "@bb/db";
import { createMigratedConnection } from "@bb/db/testing";
import type { DbConnection } from "@bb/db";
import type { TimelineRow } from "@bb/server-contract";
import { buildThreadTimelineWithProfile } from "../../../src/services/threads/timeline.js";

const providerThreadId = "provider-root";

const execution = {
  model: "gpt-5",
  serviceTier: "default",
  reasoningLevel: "medium",
  permissionMode: "full",
  source: "client/turn/requested",
} as const;

interface SetupResult {
  db: DbConnection;
  thread: Thread;
}

function setup(): SetupResult {
  const db = createMigratedConnection();
  const host = upsertHost(db, noopNotifier, {
    name: "test-host",
  });
  const { project } = createProject(db, noopNotifier, {
    name: "test-project",
    source: { type: "local_path", hostId: host.id, path: "/tmp/test" },
  });
  const thread = createThread(db, noopNotifier, {
    projectId: project.id,
    providerId: "claude-code",
  });
  return { db, thread };
}

function requestId(value: number): ClientTurnRequestId {
  return encodeClientTurnRequestIdNumber({ value });
}

function clientTurnRequested(
  thread: Thread,
  sequence: number,
  value: number,
  text: string,
) {
  return {
    threadId: thread.id,
    sequence,
    type: "client/turn/requested" as const,
    scope: threadScope(),
    itemId: null,
    itemKind: null,
    parentToolCallId: null,
    data: JSON.stringify({
      direction: "outbound",
      source: value === 1 ? "spawn" : "tell",
      initiator: "user",
      request: {
        method: value === 1 ? "thread/start" : "turn/start",
        params: {},
      },
      requestId: requestId(value),
      senderThreadId: null,
      input: [{ type: "text", text, mentions: [] }],
      target: { kind: value === 1 ? "thread-start" : "new-turn" },
      execution,
    }),
  };
}

function turnStart(
  thread: Thread,
  sequence: number,
  turnId: string,
  value: number,
) {
  return [
    {
      threadId: thread.id,
      sequence,
      type: "turn/started" as const,
      scope: turnScope(turnId),
      providerThreadId,
      itemId: null,
      itemKind: null,
      parentToolCallId: null,
      data: JSON.stringify({}),
    },
    {
      threadId: thread.id,
      sequence: sequence + 1,
      type: "turn/input/accepted" as const,
      scope: turnScope(turnId),
      providerThreadId,
      itemId: null,
      itemKind: null,
      parentToolCallId: null,
      data: JSON.stringify({ clientRequestId: requestId(value) }),
    },
  ];
}

function agentMessage(
  thread: Thread,
  sequence: number,
  turnId: string,
  itemId: string,
  text: string,
  parentToolCallId: string | null,
) {
  return {
    threadId: thread.id,
    sequence,
    type: "item/completed" as const,
    scope: turnScope(turnId),
    providerThreadId,
    itemId,
    itemKind: "agentMessage" as const,
    parentToolCallId,
    data: JSON.stringify({
      item: {
        type: "agentMessage",
        id: itemId,
        text,
        ...(parentToolCallId === null ? {} : { parentToolCallId }),
      },
    }),
  };
}

function agentToolCall(
  thread: Thread,
  sequence: number,
  type: "item/started" | "item/completed",
) {
  return {
    threadId: thread.id,
    sequence,
    type,
    scope: turnScope("parent-turn"),
    providerThreadId,
    itemId: "toolu_agent_1",
    itemKind: "toolCall" as const,
    parentToolCallId: null,
    data: JSON.stringify({
      item: {
        type: "toolCall",
        id: "toolu_agent_1",
        tool: "Agent",
        arguments: {
          prompt: "Run the child.",
          subagent_type: "general-purpose",
        },
        status: type === "item/started" ? "pending" : "completed",
        ...(type === "item/completed" ? { result: "AGENT_RESULT" } : {}),
      },
    }),
  };
}

function insertParentLookupEvents(db: DbConnection, thread: Thread): void {
  insertEvents(db, noopNotifier, [
    clientTurnRequested(thread, 1, 1, "Start parent turn."),
    ...turnStart(thread, 2, "parent-turn", 1),
    agentToolCall(thread, 4, "item/started"),
    agentToolCall(thread, 5, "item/completed"),
    clientTurnRequested(thread, 20, 2, "Newest turn."),
    ...turnStart(thread, 21, "newest-turn", 2),
    agentMessage(
      thread,
      23,
      "newest-turn",
      "newest-message",
      "Newest response.",
      null,
    ),
    agentMessage(
      thread,
      24,
      "newest-turn",
      "child-message",
      "CHILD_OUTPUT",
      "toolu_agent_1",
    ),
    agentMessage(
      thread,
      25,
      "newest-turn",
      "orphan-message",
      "ORPHAN_OUTPUT",
      "toolu_missing",
    ),
  ]);
}

function captureSql(db: DbConnection, run: () => void): string[][] {
  const captured: string[][] = [];
  const raw = db.$client;
  const originalPrepare = raw.prepare.bind(raw);
  Object.defineProperty(raw, "prepare", {
    configurable: true,
    writable: true,
    value: (source: string) => {
      const statement = originalPrepare(source);
      const originalAll = statement.all.bind(statement);
      statement.all = (...params: unknown[]) => {
        if (source.includes("INDEXED BY events_delegating_item_lookup_idx")) {
          captured.push(params.map(String));
        }
        return originalAll(...params);
      };
      return statement;
    },
  });
  try {
    run();
  } finally {
    Object.defineProperty(raw, "prepare", {
      configurable: true,
      writable: true,
      value: originalPrepare,
    });
  }
  return captured;
}

function nestedRows(row: TimelineRow): readonly TimelineRow[] {
  if (row.kind === "turn") {
    return row.children ?? [];
  }
  if (row.kind === "work" && row.workKind === "delegation") {
    return row.childRows ?? [];
  }
  return [];
}

function rowTexts(rows: readonly TimelineRow[]): string[] {
  const texts: string[] = [];
  const visit = (currentRows: readonly TimelineRow[]): void => {
    for (const row of currentRows) {
      if (row.kind === "conversation") {
        texts.push(row.text);
      }
      visit(nestedRows(row));
    }
  };
  visit(rows);
  return texts;
}

describe("thread timeline parent lookups", () => {
  it("looks up each absent parent once across group-context rounds", () => {
    const { db, thread } = setup();
    insertParentLookupEvents(db, thread);

    let rows: readonly TimelineRow[] = [];
    const lookups = captureSql(db, () => {
      rows = buildThreadTimelineWithProfile(db, thread, {
        completedTurnDisplay: "collapse",
        eventBudget: 1_000_000,
        includeClearedContextHistory: false,
        includeDiagnosticOperations: false,
        includeNestedRows: true,
        maxInlineOutputChars: null,
        maxSeq: 25,
        page: { kind: "latest", segmentLimit: 1 },
      }).response.rows;
    });

    expect(lookups).toEqual([
      [
        thread.id,
        "toolu_agent_1",
        "toolu_missing",
        "item/started",
        "item/completed",
      ],
    ]);
    expect(rowTexts(rows)).toEqual(["Newest turn.", "Newest response."]);
  });
});
