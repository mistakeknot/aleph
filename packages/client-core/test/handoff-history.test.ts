import { expect, it } from "vitest";
import type { ThreadEventRow } from "@bb/domain";
import {
  buildHandoffHistoryPacket,
  HANDOFF_HISTORY_BUDGET_BYTES,
} from "../src/prompt/handoff-excerpt.js";

function message(seq: number, text: string, user = false): ThreadEventRow {
  return {
    id: `event${seq}`,
    threadId: "source",
    seq,
    createdAt: seq,
    scope: { kind: "thread" },
    type: "item/completed",
    data: {
      providerThreadId: "native",
      item: user
        ? {
            type: "userMessage",
            id: `item${seq}`,
            content: [{ type: "text", text }],
          }
        : { type: "agentMessage", id: `item${seq}`, text },
    },
  };
}
it("keeps the original constraint and recent failure through long history", () => {
  const history = [
    message(1, "Never deploy", true),
    ...Array.from({ length: 100 }, (_, i) =>
      message(i + 2, "result ".repeat(100)),
    ),
    message(102, "Command failed: exit 1"),
  ];
  const packet = buildHandoffHistoryPacket({
    sourceThreadId: "source",
    sourceEvents: history,
    reservedBytes: 0,
  });
  expect(packet?.text).toContain("Never deploy");
  expect(packet?.text).toContain("Command failed");
  expect(packet?.text).toContain("event102");
  expect(packet?.omitted.length).toBeGreaterThan(0);
  expect(new TextEncoder().encode(packet!.text).length).toBeLessThanOrEqual(
    HANDOFF_HISTORY_BUDGET_BYTES,
  );
});
it("counts attachment bytes, skips reasoning and foreign history, and has a stable retry ID", () => {
  const history = [
    message(1, "request", true),
    message(2, "result ".repeat(1000)),
  ];
  const full = buildHandoffHistoryPacket({
    sourceThreadId: "source",
    sourceEvents: history,
    reservedBytes: 0,
  })!;
  const small = buildHandoffHistoryPacket({
    sourceThreadId: "source",
    sourceEvents: history,
    reservedBytes: HANDOFF_HISTORY_BUDGET_BYTES - 1000,
  })!;
  expect(small.omitted).toContain("event2");
  expect(small.id).toBe(full.id);
  expect(
    buildHandoffHistoryPacket({
      sourceThreadId: "source",
      sourceEvents: history,
      reservedBytes: 0,
      existingPacketIds: [full.id],
    }),
  ).toBeNull();
  expect(
    buildHandoffHistoryPacket({
      sourceThreadId: "source",
      sourceEvents: history,
      reservedBytes: HANDOFF_HISTORY_BUDGET_BYTES,
    }),
  ).toBeNull();
  const reasoning: ThreadEventRow = {
    ...message(3, ""),
    type: "item/completed",
    data: {
      providerThreadId: "native",
      item: {
        type: "reasoning",
        id: "reason",
        summary: ["secret"],
        content: ["secret"],
      },
    },
  };
  expect(
    buildHandoffHistoryPacket({
      sourceThreadId: "source",
      sourceEvents: [
        ...history,
        reasoning,
        { ...message(4, "foreign"), threadId: "other" },
      ],
      reservedBytes: 0,
    })!.text,
  ).not.toMatch(/secret|foreign/);
});

import {
  buildThreadHandoffCreateRequest,
  buildThreadHandoffPromptDraft,
  type ThreadHandoffExecutionSelection,
} from "../src/prompt/thread-handoff-request.js";
import { promptInputToDraft } from "../src/prompt/prompt-draft.js";

const seed = {
  sourceThreadId: "source",
  sourceThreadTitle: "Source",
  projectId: "project",
  environmentId: null,
};
const execution: ThreadHandoffExecutionSelection = {
  providerId: "codex",
  model: "model",
  reasoningLevel: "high",
  serviceTier: undefined,
  supportsServiceTier: false,
  permissionMode: "auto",
};

it("leaves disabled output byte-identical and counts actual attachments in the request", () => {
  const draft = buildThreadHandoffPromptDraft(seed);
  const history = [
    message(1, "Never deploy", true),
    message(2, "result ".repeat(1000)),
    {
      ...message(3, ""),
      type: "system/error" as const,
      data: { message: "Recent failure" },
    },
  ];
  const baseline = buildThreadHandoffCreateRequest({ seed, execution, draft });
  expect(
    JSON.stringify(
      buildThreadHandoffCreateRequest({
        seed,
        execution,
        draft,
        historyExcerpt: { enabled: false, sourceEvents: history },
      }),
    ),
  ).toBe(JSON.stringify(baseline));
  const withHistory = buildThreadHandoffCreateRequest({
    seed,
    execution,
    draft,
    historyExcerpt: { enabled: true, sourceEvents: history },
  })!;
  expect(JSON.stringify(withHistory.input)).toContain("Recent failure");
  expect(withHistory.input[0]).toMatchObject({
    type: "text",
    mentions: draft.mentions,
  });
  const attachment = {
    type: "localFile" as const,
    path: "large.txt",
    name: "large.txt",
    sizeBytes: HANDOFF_HISTORY_BUDGET_BYTES - 1600,
    mimeType: "text/plain",
  };
  const attached = {
    ...draft,
    attachments: promptInputToDraft([attachment]).attachments,
  };
  const request = buildThreadHandoffCreateRequest({
    seed,
    execution,
    draft: attached,
    historyExcerpt: { enabled: true, sourceEvents: history },
  })!;
  const text = request.input.find((item) => item.type === "text")!;
  expect(text.type === "text" && text.text).toContain('"omitted":["event2"]');
  expect(request.input).toContainEqual(attachment);
  const retry = buildThreadHandoffCreateRequest({
    seed,
    execution,
    draft: promptInputToDraft(withHistory.input),
    historyExcerpt: { enabled: true, sourceEvents: history },
  })!;
  expect(retry.input).toEqual(withHistory.input);
});

it("includes command outcomes and file summaries without copying diffs", () => {
  const command: ThreadEventRow = {
    ...message(2, ""),
    type: "item/completed",
    data: {
      providerThreadId: "native",
      item: {
        type: "commandExecution",
        id: "cmd",
        command: "pnpm test",
        cwd: ".",
        status: "completed",
        approvalStatus: null,
        exitCode: 1,
        aggregatedOutput: "Test failed",
      },
    },
  };
  const change: ThreadEventRow = {
    ...message(3, ""),
    type: "item/completed",
    data: {
      providerThreadId: "native",
      item: {
        type: "fileChange",
        id: "edit",
        status: "completed",
        approvalStatus: null,
        changes: [{ path: "source.ts", kind: "update", diff: "huge raw diff" }],
      },
    },
  };
  const packet = buildHandoffHistoryPacket({
    sourceThreadId: "source",
    sourceEvents: [
      message(1, "request", true),
      command,
      change,
      message(4, "Use the small fix", true),
    ],
    reservedBytes: 0,
  })!;
  expect(packet.text).toContain("Test failed");
  expect(packet.text).toContain("source.ts");
  expect(packet.text).toContain("Use the small fix");
  expect(packet.text).not.toContain("huge raw diff");
});

it("fails closed when the omitted-reference index or unknown attachment size cannot fit", () => {
  const sourceEvents = Array.from({ length: 5000 }, (_, i) =>
    message(i, "result"),
  );
  expect(
    buildHandoffHistoryPacket({
      sourceThreadId: "source",
      sourceEvents,
      reservedBytes: 0,
    }),
  ).toBeNull();
  const draft = buildThreadHandoffPromptDraft(seed);
  const attached = {
    ...draft,
    attachments: promptInputToDraft([
      { type: "localFile", path: "unknown.txt" },
    ]).attachments,
  };
  expect(
    buildThreadHandoffCreateRequest({
      seed,
      execution,
      draft: attached,
      historyExcerpt: {
        enabled: true,
        sourceEvents: [message(1, "request", true)],
      },
    })?.input,
  ).toEqual(
    buildThreadHandoffCreateRequest({ seed, execution, draft: attached })
      ?.input,
  );
});
