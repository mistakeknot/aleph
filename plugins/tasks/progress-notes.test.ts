import {
  createFakePluginHost,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { createProgressNote, createStore, registerTasksApi } from "./api";
import { tasksRpcContract } from "./shared/contract";
import { commentsTag, progressNotesTag } from "./shared/tags";

const OWNER_THREAD = "thr_progress_owner";
const WRITER_THREAD = "thr_progress_writer";

function setup() {
  const { bb, harness } = createFakePluginHost({
    pluginId: "tasks",
    sdk: {
      threads: {
        get: async ({ threadId }) =>
          makeThreadResponse({ id: threadId, status: "active" }),
        send: async () => undefined,
      },
    },
  });
  const store = createStore(bb);
  registerTasksApi(bb, store);
  const project = store.tasks.createProject({
    name: "Progress",
    prefix: "PRG",
    color: "blue",
  });
  const task = store.tasks.createTask({
    projectId: project.id,
    title: "Quiet progress",
  });
  return { bb, harness, store, task };
}

async function rpcProgress(
  harness: ReturnType<typeof setup>["harness"],
  input: Record<string, unknown>,
) {
  return tasksRpcContract.createProgressNote.output.parse(
    await harness.callRpc("createProgressNote", input),
  ).progressNote;
}

describe("task progress notes store", () => {
  it("keeps notes separate from comments and orders them by time then id", () => {
    const { harness, store, task } = setup();
    store.tasks.createComment({
      taskId: task.id,
      kind: "user",
      authorName: "You",
      body: "A comment",
    });
    const first = store.tasks.createProgressNote({
      taskId: task.id,
      authorName: "agent (thr_one)",
      presetName: "Default",
      threadId: "thr_one",
      body: "First step",
      proofUrl: "https://example.test/proof/1",
    });
    const second = store.tasks.createProgressNote({
      taskId: task.id,
      authorName: "cli",
      presetName: null,
      threadId: null,
      body: "Second step",
      proofUrl: null,
    });

    expect(store.tasks.listProgressNotes(task.id)).toEqual([first, second]);
    expect(first).toMatchObject({
      taskId: task.id,
      authorName: "agent (thr_one)",
      presetName: "Default",
      threadId: "thr_one",
      body: "First step",
      proofUrl: "https://example.test/proof/1",
    });
    expect(second.proofUrl).toBeNull();
    expect(store.tasks.listComments(task.id)).toHaveLength(1);
    return harness.dispose();
  });

  it("rejects a blank author, a malformed thread id and an unknown task", async () => {
    const { harness, store, task } = setup();
    expect(() =>
      store.tasks.createProgressNote({
        taskId: task.id,
        authorName: "  ",
        presetName: null,
        threadId: null,
        body: "x",
        proofUrl: null,
      }),
    ).toThrow();
    expect(() =>
      store.tasks.createProgressNote({
        taskId: task.id,
        authorName: "cli",
        presetName: null,
        threadId: "worker",
        body: "x",
        proofUrl: null,
      }),
    ).toThrow();
    expect(() =>
      store.tasks.createProgressNote({
        taskId: "01HZZZZZZZZZZZZZZZZZZZZZZZ",
        authorName: "cli",
        presetName: null,
        threadId: null,
        body: "x",
        proofUrl: null,
      }),
    ).toThrow();
    expect(store.tasks.listProgressNotes(task.id)).toEqual([]);
    await harness.dispose();
  });
});

describe("createProgressNote RPC", () => {
  it("records a trimmed note without a proof link using comment-style author defaults", async () => {
    const { harness, task } = setup();
    const note = await rpcProgress(harness, {
      taskId: task.id,
      body: "  Parser reads the new field.  \n",
    });
    expect(note).toMatchObject({
      taskId: task.id,
      authorName: "You",
      presetName: null,
      threadId: null,
      body: "Parser reads the new field.",
      proofUrl: null,
    });
    expect(harness.experimental_rpcInvalidations).toEqual([
      [progressNotesTag(task.id)],
    ]);
    await harness.dispose();
  });

  it("records an author, thread identity and an http(s) proof link", async () => {
    const { harness, task } = setup();
    const note = await rpcProgress(harness, {
      taskId: task.id,
      body: "Tests pass locally",
      proofUrl: "https://example.test/runs/42?tab=logs",
      authorName: "agent (thr_progress_writer)",
      threadId: WRITER_THREAD,
    });
    expect(note).toMatchObject({
      authorName: "agent (thr_progress_writer)",
      threadId: WRITER_THREAD,
      proofUrl: "https://example.test/runs/42?tab=logs",
    });
    const listed = tasksRpcContract.listProgressNotes.output.parse(
      await harness.callRpc("listProgressNotes", { taskId: task.id }),
    );
    expect(listed.progressNotes).toEqual([note]);
    await harness.dispose();
  });

  it("accepts the exact body and proof URL length limits", async () => {
    const { harness, task } = setup();
    const url = `http://example.test/${"a".repeat(2048 - "http://example.test/".length)}`;
    expect(url).toHaveLength(2048);
    const note = await rpcProgress(harness, {
      taskId: task.id,
      body: `  ${"b".repeat(2000)}  `,
      proofUrl: url,
    });
    expect(note.body).toHaveLength(2000);
    expect(note.proofUrl).toBe(url);
    await harness.dispose();
  });

  it.each([
    ["an empty body", { body: "" }],
    ["a whitespace-only body", { body: " \n\t " }],
    ["a body over 2000 characters", { body: "x".repeat(2001) }],
    ["a malformed proof URL", { body: "ok", proofUrl: "not a url" }],
    ["a relative proof URL", { body: "ok", proofUrl: "/runs/42" }],
    ["an empty proof URL", { body: "ok", proofUrl: "" }],
    ["an ftp proof URL", { body: "ok", proofUrl: "ftp://example.test/x" }],
    ["a javascript proof URL", { body: "ok", proofUrl: "javascript:alert(1)" }],
    ["a data proof URL", { body: "ok", proofUrl: "data:text/html,hi" }],
    [
      "a proof URL over 2048 characters",
      {
        body: "ok",
        proofUrl: `https://example.test/${"a".repeat(2049 - "https://example.test/".length)}`,
      },
    ],
    ["a non-thread id", { body: "ok", threadId: "worker" }],
    ["an unknown field", { body: "ok", notify: true }],
  ])("rejects %s without writing or signalling", async (_name, extra) => {
    const { harness, store, task } = setup();
    await expect(
      harness.callRpc("createProgressNote", { taskId: task.id, ...extra }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(store.tasks.listProgressNotes(task.id)).toEqual([]);
    expect(harness.experimental_rpcInvalidations).toEqual([]);
    await harness.dispose();
  });

  it("never fetches the proof URL", async () => {
    const { harness, task } = setup();
    const fetched: unknown[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = ((...args: unknown[]) => {
      fetched.push(args);
      return Promise.reject(new Error("no network in tests"));
    }) as typeof fetch;
    try {
      await rpcProgress(harness, {
        taskId: task.id,
        body: "Linked",
        proofUrl: "https://example.test/never-fetched",
      });
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(fetched).toEqual([]);
    await harness.dispose();
  });
});

describe("quiet progress versus notifying comments", () => {
  it("sends a notifying comment but never a progress note, and notes never become the latest responder", async () => {
    const { bb, harness, store, task } = setup();
    store.tasks.createComment({
      taskId: task.id,
      kind: "agent",
      authorName: "Owner",
      threadId: OWNER_THREAD,
      body: "Prior reply",
    });
    const taskBefore = store.tasks.getTask(task.id);

    await harness.callRpc("createComment", {
      taskId: task.id,
      body: "Positive control",
      notify: true,
    });
    await expect
      .poll(
        () =>
          store.tasks
            .listComments(task.id)
            .find((comment) => comment.body === "Positive control")
            ?.notifiedCount,
      )
      .toBe(1);
    expect(harness.sdk.callsTo("threads.send")).toHaveLength(1);
    expect(harness.sdk.callsTo("threads.send")[0]).toEqual([
      expect.objectContaining({
        threadId: OWNER_THREAD,
        mode: "steer-if-active",
      }),
    ]);

    const sdkCallsBefore = harness.sdk.calls.length;
    const commentsBefore = store.tasks.listComments(task.id);
    const invalidationsBefore = harness.experimental_rpcInvalidations.length;

    await rpcProgress(harness, {
      taskId: task.id,
      body: "Quiet RPC step",
      authorName: "agent (thr_progress_writer)",
      threadId: WRITER_THREAD,
    });
    await createProgressNote(bb, store, {
      taskId: task.id,
      authorName: "agent (thr_progress_writer)",
      presetName: null,
      threadId: WRITER_THREAD,
      body: "Quiet direct step",
      proofUrl: null,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(harness.sdk.calls.length).toBe(sdkCallsBefore);
    expect(harness.sdk.callsTo("threads.send")).toHaveLength(1);
    expect(store.tasks.listComments(task.id)).toEqual(commentsBefore);
    expect(store.tasks.getTask(task.id)).toEqual(taskBefore);
    expect(
      store.tasks.getLatestAgentComment(task.id, "no-excluded-comment")
        ?.threadId,
    ).toBe(OWNER_THREAD);
    expect(
      harness.experimental_rpcInvalidations.slice(invalidationsBefore),
    ).toEqual([[progressNotesTag(task.id)], [progressNotesTag(task.id)]]);
    expect(
      harness.experimental_rpcInvalidations
        .slice(invalidationsBefore)
        .flat()
        .includes(commentsTag(task.id)),
    ).toBe(false);

    await harness.callRpc("createComment", {
      taskId: task.id,
      body: "Second positive control",
      notify: true,
    });
    await expect
      .poll(
        () =>
          store.tasks
            .listComments(task.id)
            .find((comment) => comment.body === "Second positive control")
            ?.notifiedCount,
      )
      .toBe(1);
    expect(harness.sdk.callsTo("threads.send")).toHaveLength(2);
    expect(harness.sdk.callsTo("threads.send")[1]).toEqual([
      expect.objectContaining({ threadId: OWNER_THREAD }),
    ]);
    expect(
      harness.sdk
        .callsTo("threads.send")
        .some(([call]) => JSON.stringify(call).includes(WRITER_THREAD)),
    ).toBe(false);
    await harness.dispose();
  });

  it("leaves comment reads and writes unchanged when notes exist", async () => {
    const { harness, store, task } = setup();
    await rpcProgress(harness, { taskId: task.id, body: "Quiet step" });
    const created = tasksRpcContract.createComment.output.parse(
      await harness.callRpc("createComment", {
        taskId: task.id,
        body: "Readable comment",
        notify: false,
      }),
    ).comment;
    const listed = tasksRpcContract.listComments.output.parse(
      await harness.callRpc("listComments", { taskId: task.id }),
    );
    expect(listed.comments.map((comment) => comment.id)).toEqual([created.id]);
    expect(store.tasks.listProgressNotes(task.id)).toHaveLength(1);
    await harness.dispose();
  });
});
