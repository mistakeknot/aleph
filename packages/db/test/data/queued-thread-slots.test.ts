import { describe, expect, it } from "vitest";
import { archiveThread, deleteThread } from "../../src/data/threads.js";
import { noopNotifier } from "../../src/notifier.js";
import {
  getQueuedThreadMessage,
} from "../../src/data/queued-thread-messages.js";
import { abort, allRows, claim, enqueue, entries, release, retire, setup } from "../helpers/retire-fixture.js";
import type { Fixture } from "../helpers/retire-fixture.js";

describe("slots at retire (G4)", () => {
  it("creates a slot on the target tail for a claimed inline row and leaves the claim on the source", () => {
    const f = setup();
    const a = enqueue(f.db, f.source.id, "a");
    const b = enqueue(f.db, f.source.id, "b");
    const c = enqueue(f.db, f.source.id, "c");
    const claimed = claim(f, b.id);
    const outcome = retire(f);
    if (outcome.kind !== "retired") throw new Error(outcome.kind);
    expect(outcome.result.moved.map((m) => m.id)).toEqual([a.id, c.id]);
    expect(outcome.result.pending).toHaveLength(1);
    expect(outcome.result.pending[0]).toMatchObject({
      id: b.id,
      originId: b.id,
    });
    const targetRows = allRows(f, f.target.id);
    expect(targetRows).toHaveLength(3);
    const slot = targetRows.find((row) => row.forwardSourceRowId === b.id);
    expect(slot).toBeDefined();
    expect(slot?.claimToken).toBe(`slot:${b.id}`);
    expect(slot?.claimedAt).not.toBeNull();
    expect(slot?.originId).toBe(b.id);
    expect(getQueuedThreadMessage(f.db, b.id)).toMatchObject({
      threadId: f.source.id,
      claimToken: claimed.claimToken,
    });
    const slotEntry = entries(f, outcome.operationId).find(
      (entry) => entry.kind === "slot",
    );
    expect(slotEntry).toMatchObject({
      state: "pending",
      sourceRowId: b.id,
      targetRowId: slot?.id,
      originId: b.id,
    });
    expect(
      targetRows.map((row) => row.id).indexOf(slot?.id ?? ""),
    ).toBeGreaterThan(-1);
  });

  it("orders the slot among moved rows by the source walk", () => {
    const f = setup();
    const a = enqueue(f.db, f.source.id, "a");
    const b = enqueue(f.db, f.source.id, "b");
    const c = enqueue(f.db, f.source.id, "c");
    claim(f, b.id);
    retire(f);
    const targetRows = allRows(f, f.target.id);
    expect(targetRows.map((row) => row.originId)).toEqual([a.id, b.id, c.id]);
  });

  it("refuses a claimed non-inline row as not forwardable, never a slot", () => {
    const f = setup();
    const a = enqueue(f.db, f.source.id, "a", {
      payload: { kind: "inline" },
    });
    claim(f, a.id);
    const outcome = retire(f);
    if (outcome.kind !== "retired") throw new Error(outcome.kind);
    expect(outcome.result.pending).toHaveLength(1);
  });
});

describe("T1 claim exit (G4; T-T1)", () => {
  it("fills the slot when the source claim is released and deletes the source", () => {
    const f = setup();
    const a = enqueue(f.db, f.source.id, "a");
    const claimed = claim(f, a.id);
    const outcome = retire(f);
    if (outcome.kind !== "retired") throw new Error(outcome.kind);
    release(f, a.id, claimed.claimToken);
    expect(getQueuedThreadMessage(f.db, a.id)).toBeNull();
    const rows = allRows(f, f.target.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      claimedAt: null,
      claimToken: null,
      forwardSourceRowId: null,
      originId: a.id,
    });
    expect(entries(f, outcome.operationId)[0]).toMatchObject({
      kind: "slot",
      state: "forwarded",
      detail: null,
    });
  });

  it("marks the entry target_archived when the slot thread is archived", () => {
    const f = setup();
    const a = enqueue(f.db, f.source.id, "a");
    const claimed = claim(f, a.id);
    const outcome = retire(f);
    if (outcome.kind !== "retired") throw new Error(outcome.kind);
    archiveThread(f.db, noopNotifier, f.target.id);
    release(f, a.id, claimed.claimToken);
    expect(entries(f, outcome.operationId)[0]).toMatchObject({
      state: "forwarded",
      detail: "target_archived",
    });
    expect(allRows(f, f.target.id)).toHaveLength(1);
  });

  it("settles target_deleted and removes the source when the slot thread is soft-deleted but the soft-delete trigger is absent (backstop)", () => {
    const f = setup();
    const a = enqueue(f.db, f.source.id, "a");
    const claimed = claim(f, a.id);
    const outcome = retire(f);
    if (outcome.kind !== "retired") throw new Error(outcome.kind);
    f.db.$client.exec("DROP TRIGGER threads_soft_deleted");
    f.db.$client
      .prepare("UPDATE threads SET deleted_at = 9 WHERE id = ?")
      .run(f.target.id);
    release(f, a.id, claimed.claimToken);
    expect(getQueuedThreadMessage(f.db, a.id)).toBeNull();
    expect(entries(f, outcome.operationId)[0]).toMatchObject({
      state: "target_deleted",
    });
  });
});

describe("T2 and T3 (G4; T-T2, T-T3)", () => {
  it("records target_deleted and removes the source when the slot is deleted", () => {
    const f = setup();
    const a = enqueue(f.db, f.source.id, "a");
    claim(f, a.id);
    const outcome = retire(f);
    if (outcome.kind !== "retired") throw new Error(outcome.kind);
    f.db.$client
      .prepare(
        "DELETE FROM queued_thread_messages WHERE forward_source_row_id = ?",
      )
      .run(a.id);
    expect(getQueuedThreadMessage(f.db, a.id)).toBeNull();
    expect(entries(f, outcome.operationId)[0]?.state).toBe("target_deleted");
  });

  it("records left_source and removes the slot when the source is deleted", () => {
    const f = setup();
    const a = enqueue(f.db, f.source.id, "a");
    claim(f, a.id);
    const outcome = retire(f);
    if (outcome.kind !== "retired") throw new Error(outcome.kind);
    f.db.$client
      .prepare("DELETE FROM queued_thread_messages WHERE id = ?")
      .run(a.id);
    expect(allRows(f, f.target.id)).toEqual([]);
    expect(entries(f, outcome.operationId)[0]?.state).toBe("left_source");
  });

  it("settles left_source when the source thread is hard-deleted", () => {
    const f = setup();
    const a = enqueue(f.db, f.source.id, "a");
    claim(f, a.id);
    const outcome = retire(f);
    if (outcome.kind !== "retired") throw new Error(outcome.kind);
    deleteThread(f.db, noopNotifier, f.source.id);
    expect(allRows(f, f.target.id)).toEqual([]);
    expect(entries(f, outcome.operationId)[0]?.state).toBe("left_source");
  });
});

describe("soft delete settlement (T-S1..S4)", () => {
  function softDelete(f: Fixture, threadId: string) {
    f.db.$client
      .prepare("UPDATE threads SET deleted_at = 9 WHERE id = ?")
      .run(threadId);
  }

  it("T-S1 soft-deleting the target settles target_deleted and tombstones the redirect", () => {
    const f = setup();
    const a = enqueue(f.db, f.source.id, "a");
    claim(f, a.id);
    const outcome = retire(f);
    if (outcome.kind !== "retired") throw new Error(outcome.kind);
    softDelete(f, f.target.id);
    expect(getQueuedThreadMessage(f.db, a.id)).toBeNull();
    expect(entries(f, outcome.operationId)[0]?.state).toBe("target_deleted");
    expect(
      f.db.$client
        .prepare("SELECT successor_thread_id AS s FROM thread_redirects")
        .get(),
    ).toEqual({ s: null });
  });

  it("T-S2 soft-deleting the source removes its redirect and a later release still fills the target", () => {
    const f = setup();
    const a = enqueue(f.db, f.source.id, "a");
    const claimed = claim(f, a.id);
    const outcome = retire(f);
    if (outcome.kind !== "retired") throw new Error(outcome.kind);
    softDelete(f, f.source.id);
    expect(
      f.db.$client.prepare("SELECT count(*) AS n FROM thread_redirects").get(),
    ).toEqual({ n: 0 });
    release(f, a.id, claimed.claimToken);
    expect(entries(f, outcome.operationId)[0]?.state).toBe("forwarded");
    expect(allRows(f, f.target.id)).toHaveLength(1);
  });
  it("T-S3 soft-deleting either thread after an abort touches no settled state", () => {
    const f = setup();
    const a = enqueue(f.db, f.source.id, "a");
    const op = retire(f);
    if (op.kind !== "retired") throw new Error(op.kind);
    expect(abort(f, op.operationId).kind).toBe("aborted");
    softDelete(f, f.target.id);
    softDelete(f, f.source.id);
    expect(
      f.db.$client.prepare("SELECT count(*) AS n FROM thread_redirects").get(),
    ).toEqual({ n: 0 });
    expect(getQueuedThreadMessage(f.db, a.id)).toBeNull();
  });

  it("T-S4 soft-deleting both threads of one tree settles the slot once", () => {
    const f = setup();
    const a = enqueue(f.db, f.source.id, "a");
    claim(f, a.id);
    const outcome = retire(f);
    if (outcome.kind !== "retired") throw new Error(outcome.kind);
    softDelete(f, f.source.id);
    softDelete(f, f.target.id);
    const states = entries(f, outcome.operationId).map((entry) => entry.state);
    expect(states).toHaveLength(1);
    expect(["target_deleted", "left_source"]).toContain(states[0]);
    expect(getQueuedThreadMessage(f.db, a.id)).toBeNull();
    expect(allRows(f, f.target.id)).toEqual([]);
  });
});
