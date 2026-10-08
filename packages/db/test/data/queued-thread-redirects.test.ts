import { describe, expect, it } from "vitest";
import { noopNotifier } from "../../src/notifier.js";
import {
  QueuedMessageThreadUnavailableError,
  createQueuedThreadMessage,
} from "../../src/data/queued-thread-messages.js";
import {
  allRows,
  claim,
  enqueue,
  entries,
  retire,
  setup,
} from "../helpers/retire-fixture.js";
import type { Fixture } from "../helpers/retire-fixture.js";

function post(f: Fixture, threadId: string, text: string, id?: string) {
  return createQueuedThreadMessage(f.db, noopNotifier, {
    threadId,
    ...(id === undefined ? {} : { id }),
    content: [{ type: "text", text, mentions: [] }],
    model: "gpt-5",
    reasoningLevel: "medium",
    permissionMode: "full",
    serviceTier: "default",
    waitingOn: null,
    sendAt: null,
    payload: { kind: "inline" },
    systemNotice: null,
  });
}

describe("retire refusal for a thread that holds a slot (T-H1)", () => {
  it("refuses to retire a thread that only holds a slot, with source_is_retire_target", () => {
    const f = setup();
    const third = f.make();
    const a = enqueue(f.db, f.source.id, "a");
    claim(f, a.id);
    const first = retire(f);
    if (first.kind !== "retired") throw new Error(first.kind);
    f.db.$client.prepare("DELETE FROM thread_redirects").run();
    const outcome = retire(f, {
      sourceThreadId: f.target.id,
      targetThreadId: third.id,
      operationKey: "key-2",
    });
    expect(outcome).toEqual({
      kind: "refused",
      reason: "source_is_retire_target",
    });
  });

  it("allows retiring the former target once the slot has settled", () => {
    const f = setup();
    const third = f.make();
    const a = enqueue(f.db, f.source.id, "a");
    const claimed = claim(f, a.id);
    const first = retire(f);
    if (first.kind !== "retired") throw new Error(first.kind);
    f.db.$client.prepare("DELETE FROM thread_redirects").run();
    f.db.$client
      .prepare("DELETE FROM queued_thread_messages WHERE id = ?")
      .run(a.id);
    expect(claimed.id).toBe(a.id);
    const outcome = retire(f, {
      sourceThreadId: f.target.id,
      targetThreadId: third.id,
      operationKey: "key-2",
    });
    expect(outcome.kind).toBe("retired");
  });
});

describe("ingress resolver (G6)", () => {
  it("inserts normally when the thread has no redirect", () => {
    const f = setup();
    const row = post(f, f.source.id, "plain");
    expect(row.threadId).toBe(f.source.id);
    expect(entries(f, "none")).toEqual([]);
  });

  it("redirects a post for a retired thread to the successor tail with an entry whose origin is the arrival id (T-O4)", () => {
    const f = setup();
    const a = enqueue(f.db, f.source.id, "a");
    const outcome = retire(f);
    if (outcome.kind !== "retired") throw new Error(outcome.kind);
    const arrival = post(f, f.source.id, "late");
    expect(arrival.threadId).toBe(f.target.id);
    expect(arrival.originId).toBe(arrival.id);
    const rows = allRows(f, f.target.id);
    expect(rows.map((r) => r.originId)).toEqual([a.id, arrival.id]);
    expect(allRows(f, f.source.id)).toEqual([]);
    const redirected = entries(f, outcome.operationId).filter(
      (entry) => entry.kind === "redirected",
    );
    expect(redirected).toHaveLength(1);
    expect(redirected[0]).toMatchObject({
      state: "terminal",
      originId: arrival.id,
      targetRowId: arrival.id,
    });
  });

  it("fails closed on a duplicate supplied origin for a redirected arrival (T-O4)", () => {
    const f = setup();
    const a = enqueue(f.db, f.source.id, "a");
    const outcome = retire(f);
    if (outcome.kind !== "retired") throw new Error(outcome.kind);
    expect(() =>
      createQueuedThreadMessage(f.db, noopNotifier, {
        threadId: f.source.id,
        originId: a.id,
        content: [{ type: "text", text: "dup", mentions: [] }],
        model: "gpt-5",
        reasoningLevel: "medium",
        permissionMode: "full",
        serviceTier: "default",
        waitingOn: null,
        sendAt: null,
        payload: { kind: "inline" },
        systemNotice: null,
      }),
    ).toThrow();
    expect(allRows(f, f.target.id)).toHaveLength(1);
    expect(
      entries(f, outcome.operationId).filter((e) => e.kind === "redirected"),
    ).toEqual([]);
  });

  it("refuses a post to a tombstoned thread with retired_no_successor", () => {
    const f = setup();
    enqueue(f.db, f.source.id, "a");
    const outcome = retire(f);
    if (outcome.kind !== "retired") throw new Error(outcome.kind);
    f.db.$client
      .prepare("UPDATE threads SET deleted_at = 9 WHERE id = ?")
      .run(f.target.id);
    let error: unknown;
    try {
      post(f, f.source.id, "late");
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(QueuedMessageThreadUnavailableError);
    expect((error as QueuedMessageThreadUnavailableError).reason).toBe(
      "retired_no_successor",
    );
  });

  it("refuses a redirect chain with redirect_depth_exceeded", () => {
    const f = setup();
    const third = f.make();
    enqueue(f.db, f.source.id, "a");
    const outcome = retire(f);
    if (outcome.kind !== "retired") throw new Error(outcome.kind);
    f.db.$client
      .prepare(
        "INSERT INTO thread_redirects (source_thread_id, successor_thread_id, op_id) VALUES (?, ?, ?)",
      )
      .run(f.target.id, third.id, outcome.operationId);
    let error: unknown;
    try {
      post(f, f.source.id, "late");
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(QueuedMessageThreadUnavailableError);
    expect((error as QueuedMessageThreadUnavailableError).reason).toBe(
      "redirect_depth_exceeded",
    );
  });

  it("refuses a redirected post when the successor is archived (G1 fence on the head)", () => {
    const f = setup();
    enqueue(f.db, f.source.id, "a");
    const outcome = retire(f);
    if (outcome.kind !== "retired") throw new Error(outcome.kind);
    f.db.$client
      .prepare("UPDATE threads SET archived_at = 9 WHERE id = ?")
      .run(f.target.id);
    expect(() => post(f, f.source.id, "late")).toThrow(
      QueuedMessageThreadUnavailableError,
    );
  });
});
