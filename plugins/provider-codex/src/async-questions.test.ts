import { describe, expect, it, vi } from "vitest";
import {
  createFakePluginHost,
  makeThreadResponse,
  type FakePluginHost,
} from "@get-bb/plugin-sdk/testing";
import { registerAsyncQuestions } from "./async-questions.js";
import { CODEX_ASYNC_QUESTION_RENDERER_ID } from "./async-question-form.js";

const THREAD_ID = "thr_async";

function questionRow(seq: number, title = "Choose a, b, or c.") {
  return {
    id: `event-${seq}`,
    threadId: THREAD_ID,
    seq,
    createdAt: seq,
    scope: { kind: "thread" },
    type: "thread/extensionState/updated",
    data: {
      kind: "provider-codex/async-question",
      payload: {
        itemId: `call-${seq}`,
        questions: [{ title, options: ["a", "b", "c"] }],
      },
    },
  };
}

function createHost(rows: ReturnType<typeof questionRow>[]): FakePluginHost {
  const host = createFakePluginHost({ pluginId: "provider-codex" });
  host.harness.sdk.stub(
    "threads.events.list",
    async (args: { afterSeq: string }) =>
      rows.filter((row) => row.seq > Number(args.afterSeq)),
  );
  host.harness.sdk.stub("threads.send", async () => ({}));
  registerAsyncQuestions(
    host.bb as unknown as Parameters<typeof registerAsyncQuestions>[0],
  );
  return host;
}

async function notify(host: FakePluginHost, providerId = "codex") {
  await host.harness.emitThreadEvent("experimental_thread.events", {
    thread: makeThreadResponse({ id: THREAD_ID, providerId }),
    sequence: 10,
  });
}

describe("Codex async questions", () => {
  it("asks once in the thread and sends the answer as a message", async () => {
    const host = createHost([questionRow(5)]);

    await notify(host);
    await vi.waitFor(() =>
      expect(host.harness.pendingInteractions).toHaveLength(1),
    );
    const pending = host.harness.pendingInteractions[0]!;
    expect(pending).toMatchObject({
      threadId: THREAD_ID,
      rendererId: CODEX_ASYNC_QUESTION_RENDERER_ID,
      presentation: {
        label: { pending: "Asking a question", completed: "Asked a question" },
      },
      payload: {
        questions: [{ title: "Choose a, b, or c.", options: ["a", "b", "c"] }],
      },
    });

    await notify(host);
    host.harness.submitInteraction(pending.id, {
      answers: { "question-1": { selected: ["option-2"] } },
    });

    await vi.waitFor(() =>
      expect(host.harness.sdk.callsTo("threads.send")).toEqual([
        [
          {
            wakeCause: "interaction",
            wakeRef: "call-5",
            threadId: THREAD_ID,
            mode: "auto",
            input: [
              {
                type: "text",
                text: "> Choose a, b, or c.\n\nb",
                mentions: [],
              },
            ],
          },
        ],
      ]),
    );
    await vi.waitFor(() =>
      expect(host.harness.sdk.callsTo("threads.events.list")).toHaveLength(2),
    );
    expect(host.harness.sdk.callsTo("threads.events.list")[1]?.[0]).toEqual(
      expect.objectContaining({ afterSeq: "5" }),
    );
    expect(host.harness.pendingInteractions).toHaveLength(0);
    expect(await pending.describeSubmission?.({ answers: {} })).toEqual({
      title: "Answered",
    });
  });

  it("shortens a question title too long for the card heading and keeps the full question (#4264)", async () => {
    const title = `${"Which of these should I pick? ".repeat(8)}Choose a, b, or c.`;
    const host = createHost([questionRow(5, title)]);

    await notify(host);
    await vi.waitFor(() =>
      expect(host.harness.pendingInteractions).toHaveLength(1),
    );
    const pending = host.harness.pendingInteractions[0]!;
    expect(pending.title.length).toBeLessThanOrEqual(160);
    expect(pending.title.endsWith("…")).toBe(true);
    expect(title.startsWith(pending.title.slice(0, -1))).toBe(true);
    expect(pending.payload).toEqual({
      questions: [{ title, options: ["a", "b", "c"] }],
    });
  });

  it("opens every question without waiting for earlier answers", async () => {
    const host = createHost([questionRow(5), questionRow(6)]);

    await notify(host);

    await vi.waitFor(() =>
      expect(host.harness.pendingInteractions).toHaveLength(2),
    );
  });

  it("does not send anything when the question is dismissed", async () => {
    const host = createHost([questionRow(5)]);

    await notify(host);
    await vi.waitFor(() =>
      expect(host.harness.pendingInteractions).toHaveLength(1),
    );
    host.harness.cancelInteraction(host.harness.pendingInteractions[0]!.id);

    await vi.waitFor(() =>
      expect(host.harness.pendingInteractions).toHaveLength(0),
    );
    expect(host.harness.sdk.callsTo("threads.send")).toEqual([]);
  });

  it("ignores threads from other providers", async () => {
    const host = createHost([questionRow(5)]);

    await notify(host, "claude-code");

    expect(host.harness.sdk.callsTo("threads.events.list")).toEqual([]);
  });
});

it.each(["call-short", "x".repeat(200), "x".repeat(201), "call-".repeat(100)])(
  "answers with a bounded stable item reference (%#)",
  async (itemId) => {
    const refs: string[] = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      const row = questionRow(5);
      row.data.payload.itemId = itemId;
      const host = createHost([row]);
      await notify(host);
      await vi.waitFor(() =>
        expect(host.harness.pendingInteractions).toHaveLength(1),
      );
      host.harness.submitInteraction(host.harness.pendingInteractions[0]!.id, {
        answers: { "question-1": { selected: ["option-2"] } },
      });
      await vi.waitFor(() =>
        expect(host.harness.sdk.callsTo("threads.send")).toHaveLength(1),
      );
      const request = host.harness.sdk.callsTo("threads.send")[0]![0] as {
        wakeRef: string;
      };
      expect(request.wakeRef.length).toBeLessThanOrEqual(200);
      if (itemId.length <= 200) expect(request.wakeRef).toBe(itemId);
      refs.push(request.wakeRef);
    }
    expect(refs[0]).toBe(refs[1]);
  },
);
