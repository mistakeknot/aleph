import { describe, expect, it } from "vitest";
import { archiveThread, deleteThread } from "../../src/data/threads.js";
import { noopNotifier } from "../../src/notifier.js";
import { createQueuedThreadMessage } from "../../src/data/queued-thread-messages.js";
import { recordProjectAttachment } from "../../src/data/project-attachments.js";
import { chooseRestoreKey } from "../../src/data/transfer-operations.js";
import {
  createOrderKeyAfter,
  createOrderKeyBetween,
} from "../../src/data/order-keys.js";
import {
  abort,
  allRows,
  claim,
  enqueue,
  entries,
  release,
  retire,
  setup,
} from "../helpers/retire-fixture.js";
import type { Fixture } from "../helpers/retire-fixture.js";

function retired(f: Fixture) {
  const outcome = retire(f);
  if (outcome.kind !== "retired") throw new Error(outcome.kind);
  return outcome.operationId;
}

function post(
  f: Fixture,
  threadId: string,
  text: string,
  content = [{ type: "text", text, mentions: [] }] as never,
) {
  return createQueuedThreadMessage(f.db, noopNotifier, {
    threadId,
    content,
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

function redirectCount(f: Fixture) {
  return (
    f.db.$client.prepare("SELECT count(*) AS n FROM thread_redirects").get() as {
      n: number;
    }
  ).n;
}

describe("abort refusals (T-A1)", () => {
  it("refuses an unknown operation, an abort operation and another project", () => {
    const f = setup();
    enqueue(f.db, f.source.id, "a");
    const x = retired(f);
    expect(abort(f, "top_missing")).toEqual({
      kind: "refused",
      reason: "unknown_operation",
    });
    expect(abort(f, x, { projectId: "prj_other" })).toEqual({
      kind: "refused",
      reason: "unknown_operation",
    });
    const done = abort(f, x);
    if (done.kind !== "aborted") throw new Error(done.kind);
    expect(abort(f, done.operationId, { operationKey: "abort-2" })).toEqual({
      kind: "refused",
      reason: "unknown_operation",
    });
  });

  it("refuses already_aborted before anything else once X is aborted", () => {
    const f = setup();
    enqueue(f.db, f.source.id, "a");
    const x = retired(f);
    expect(abort(f, x).kind).toBe("aborted");
    expect(abort(f, x, { operationKey: "abort-2" })).toEqual({
      kind: "refused",
      reason: "already_aborted",
    });
  });

  it("refuses stale_abort for a wrong expected operation and for a removed redirect", () => {
    const f = setup();
    enqueue(f.db, f.source.id, "a");
    const x = retired(f);
    expect(
      abort(f, x, { expectedRetirementOperationId: "top_other" }),
    ).toEqual({ kind: "refused", reason: "stale_abort" });
    f.db.$client
      .prepare("UPDATE threads SET deleted_at = 9 WHERE id = ?")
      .run(f.source.id);
    expect(abort(f, x)).toEqual({ kind: "refused", reason: "stale_abort" });
  });

  it("refuses stale_abort when the source redirect belongs to another operation", () => {
    const f = setup();
    enqueue(f.db, f.source.id, "a");
    const x = retired(f);
    const third = f.make();
    const fourth = f.make();
    enqueue(f.db, third.id, "t");
    const y = retire(f, {
      sourceThreadId: third.id,
      targetThreadId: fourth.id,
      operationKey: "key-2",
    });
    if (y.kind !== "retired") throw new Error(y.kind);
    f.db.$client
      .prepare("UPDATE thread_redirects SET op_id = ? WHERE source_thread_id = ?")
      .run(y.operationId, f.source.id);
    expect(abort(f, x)).toEqual({ kind: "refused", reason: "stale_abort" });
  });

  it("refuses successor_retired when the successor has its own redirect", () => {
    const f = setup();
    const third = f.make();
    enqueue(f.db, f.source.id, "a");
    const x = retired(f);
    f.db.$client
      .prepare(
        "INSERT INTO thread_redirects (source_thread_id, successor_thread_id, op_id) VALUES (?, ?, ?)",
      )
      .run(f.target.id, third.id, x);
    expect(abort(f, x)).toEqual({
      kind: "refused",
      reason: "successor_retired",
    });
  });

  it("refuses claims_pending for a pending entry, a claimed source row and a claimed owned row, writing nothing", () => {
    const f = setup();
    const a = enqueue(f.db, f.source.id, "a");
    const b = enqueue(f.db, f.source.id, "b");
    claim(f, a.id);
    const x = retired(f);
    const before = allRows(f, f.target.id).length;
    expect(abort(f, x)).toEqual({ kind: "refused", reason: "claims_pending" });
    expect(allRows(f, f.target.id)).toHaveLength(before);
    expect(redirectCount(f)).toBe(1);

    const g = setup();
    const c = enqueue(g.db, g.source.id, "c");
    const gx = retired(g);
    const moved = allRows(g, g.target.id).find((r) => r.originId === c.id);
    if (!moved) throw new Error("missing");
    const claimed = claim(g, moved.id);
    expect(claimed.id).toBe(moved.id);
    expect(abort(g, gx)).toEqual({ kind: "refused", reason: "claims_pending" });

    const h = setup();
    enqueue(h.db, h.source.id, "d");
    const hx = retired(h);
    const stray = enqueue(h.db, h.source.id, "stray", { redirect: "direct" });
    claim(h, stray.id);
    expect(abort(h, hx)).toEqual({ kind: "refused", reason: "claims_pending" });
    expect(b.id).toBeTruthy();
  });
});

describe("abort returns (T-A2..A8)", () => {
  it("returns moved rows to the source in the original order and finishes the operation", () => {
    const f = setup();
    const a = enqueue(f.db, f.source.id, "a");
    const b = enqueue(f.db, f.source.id, "b");
    const c = enqueue(f.db, f.source.id, "c");
    const x = retired(f);
    const outcome = abort(f, x);
    if (outcome.kind !== "aborted") throw new Error(outcome.kind);
    expect(allRows(f, f.source.id).map((r) => r.originId)).toEqual([
      a.id,
      b.id,
      c.id,
    ]);
    expect(allRows(f, f.target.id)).toEqual([]);
    expect(redirectCount(f)).toBe(0);
    expect(outcome.result.residuals).toEqual([]);
    expect(
      f.db.$client
        .prepare("SELECT state FROM transfer_operations WHERE id = ?")
        .get(x),
    ).toEqual({ state: "aborted" });
    expect(
      f.db.$client
        .prepare("SELECT state FROM transfer_operations WHERE id = ?")
        .get(outcome.operationId),
    ).toEqual({ state: "done" });
    expect(
      entries(f, outcome.operationId).map((e) => [e.kind, e.state]),
    ).toEqual([
      ["returned", "terminal"],
      ["returned", "terminal"],
      ["returned", "terminal"],
    ]);
  });

  it("returns a settled slot's row and a redirected arrival, arrival last (T-O4)", () => {
    const f = setup();
    const a = enqueue(f.db, f.source.id, "a");
    const claimed = claim(f, a.id);
    const x = retired(f);
    release(f, a.id, claimed.claimToken);
    const late = post(f, f.source.id, "late");
    const outcome = abort(f, x);
    if (outcome.kind !== "aborted") throw new Error(outcome.kind);
    expect(allRows(f, f.source.id).map((r) => r.originId)).toEqual([
      a.id,
      late.id,
    ]);
    expect(outcome.result.residuals).toEqual([]);
    expect(allRows(f, f.target.id)).toEqual([]);
  });

  it("reports sourceArchived and still returns rows to an archived source", () => {
    const f = setup();
    const a = enqueue(f.db, f.source.id, "a");
    const x = retired(f);
    archiveThread(f.db, noopNotifier, f.source.id);
    const outcome = abort(f, x);
    if (outcome.kind !== "aborted") throw new Error(outcome.kind);
    expect(outcome.result.sourceArchived).toBe(true);
    expect(allRows(f, f.source.id).map((r) => r.originId)).toEqual([a.id]);
  });

  it("produces keys the allocator accepts for both append and between", () => {
    const f = setup();
    for (const text of ["a", "b", "c", "d"]) enqueue(f.db, f.source.id, text);
    const x = retired(f);
    expect(abort(f, x).kind).toBe("aborted");
    const keys = allRows(f, f.source.id).map((r) => r.sortKey);
    expect([...keys].sort()).toEqual(keys);
    expect(() =>
      createOrderKeyAfter({ previousKey: keys[keys.length - 1] ?? null }),
    ).not.toThrow();
    expect(() =>
      createOrderKeyBetween({ previousKey: keys[0] ?? null, nextKey: keys[1] ?? null }),
    ).not.toThrow();
  });

  it("reports residual locations: a thread id, deleted:<id> and gone", () => {
    const f = setup();
    const third = f.make();
    const fourth = f.make();
    const a = enqueue(f.db, f.source.id, "a");
    const b = enqueue(f.db, f.source.id, "b");
    const c = enqueue(f.db, f.source.id, "c");
    const x = retired(f);
    const onTarget = (origin: string) =>
      allRows(f, f.target.id).find((r) => r.originId === origin)?.id ?? "";
    f.db.$client
      .prepare("UPDATE queued_thread_messages SET thread_id = ? WHERE id = ?")
      .run(third.id, onTarget(a.id));
    f.db.$client
      .prepare("UPDATE queued_thread_messages SET thread_id = ? WHERE id = ?")
      .run(fourth.id, onTarget(b.id));
    f.db.$client
      .prepare("UPDATE threads SET deleted_at = 9 WHERE id = ?")
      .run(fourth.id);
    f.db.$client
      .prepare("DELETE FROM queued_thread_messages WHERE id = ?")
      .run(onTarget(c.id));
    const outcome = abort(f, x);
    if (outcome.kind !== "aborted") throw new Error(outcome.kind);
    expect(outcome.result.residuals).toEqual(
      expect.arrayContaining([
        { originId: a.id, location: third.id },
        { originId: b.id, location: `deleted:${fourth.id}` },
        { originId: c.id, location: "gone" },
      ]),
    );
    expect(outcome.result.residuals).toHaveLength(3);
  });

  it("proceeds and lifts the tombstone when the successor is gone", () => {
    const f = setup();
    enqueue(f.db, f.source.id, "a");
    const x = retired(f);
    f.db.$client
      .prepare("UPDATE threads SET deleted_at = 9 WHERE id = ?")
      .run(f.target.id);
    const outcome = abort(f, x);
    if (outcome.kind !== "aborted") throw new Error(outcome.kind);
    expect(redirectCount(f)).toBe(0);
    expect(outcome.result.returned).toEqual([]);
  });

  it("replays the same key and conflicts on a different request", () => {
    const f = setup();
    enqueue(f.db, f.source.id, "a");
    const x = retired(f);
    const first = abort(f, x);
    if (first.kind !== "aborted") throw new Error(first.kind);
    const again = abort(f, x);
    expect(again).toMatchObject({ kind: "replayed", operationId: first.operationId });
    expect(
      abort(f, x, { expectedRetirementOperationId: "top_other" }),
    ).toEqual({ kind: "idempotency_conflict" });
  });

  it("allows retiring again after abort (T-H1)", () => {
    const f = setup();
    enqueue(f.db, f.source.id, "a");
    const x = retired(f);
    expect(abort(f, x).kind).toBe("aborted");
    expect(retire(f, { operationKey: "key-2" }).kind).toBe("retired");
  });
});

describe("restore keys (T-K1, T-K2)", () => {
  it("uses the link key when free", () => {
    expect(chooseRestoreKey(["j", "r"], "U", null)).toBe("U");
  });

  it("places the row before the occupant when the link key is taken", () => {
    const key = chooseRestoreKey(["F", "U", "j"], "U", null);
    expect(key).not.toBeNull();
    expect(key! > "F" && key! < "U").toBe(true);
  });

  it("falls back to after the occupant for a trailing-zero link key", () => {
    const key = chooseRestoreKey(["U", "U0", "j"], "U0", null);
    expect(key).not.toBeNull();
    expect(key! > "U0" && key! < "j").toBe(true);
  });

  it("refuses when no key fits", () => {
    expect(chooseRestoreKey(["U", "U0"], "U0", "U0")).toBeNull();
  });

  it("places a backfill collision between its neighbours", () => {
    const existing = ["0000000000000001", "0000000000000010"];
    const key = chooseRestoreKey(existing, "0000000000000010", null);
    expect(key).not.toBeNull();
    expect(key! > existing[0]! && key! < existing[1]!).toBe(true);
  });

  it("keeps returned order and uniqueness over 1000 fuzz rounds", () => {
    let seed = 7;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
    const randomKey = () => {
      const length = 1 + rand(3);
      let key = "";
      for (let i = 0; i < length; i += 1) key += alphabet[rand(alphabet.length)];
      return key;
    };
    for (let round = 0; round < 1000; round += 1) {
      const existing = new Set<string>();
      for (let i = rand(6); i > 0; i -= 1) existing.add(randomKey());
      const links = [...new Set(Array.from({ length: 1 + rand(4) }, randomKey))].sort();
      const placed: string[] = [];
      links.forEach((link, index) => {
        const key = chooseRestoreKey(
          [...existing, ...placed],
          link,
          links[index + 1] ?? null,
        );
        if (key === null) return;
        expect(existing.has(key)).toBe(false);
        expect(placed.includes(key)).toBe(false);
        if (placed.length > 0) expect(key > placed[placed.length - 1]!).toBe(true);
        placed.push(key);
      });
    }
  });
});

describe("attachment ownership at every landing (T-AT1)", () => {
  function attach(f: Fixture) {
    recordProjectAttachment(f.db, {
      projectId: f.project.id,
      storedPath: "uploads/a.pdf",
      originalName: "a.pdf",
      mimeType: "application/pdf",
      sizeBytes: 1,
      createdAt: 1,
      readyAt: 1,
    });
    return [{ type: "localFile", path: "uploads/a.pdf" }] as never;
  }
  const owners = (f: Fixture) =>
    (
      f.db.$client
        .prepare("SELECT thread_id FROM project_attachment_threads")
        .all() as { thread_id: string }[]
    )
      .map((row) => row.thread_id)
      .sort();
  const unowned = (f: Fixture) =>
    f.db.$client
      .prepare(
        "SELECT count(*) AS n FROM project_attachments a WHERE NOT EXISTS (SELECT 1 FROM project_attachment_threads t WHERE t.attachment_id = a.id)",
      )
      .get() as { n: number };

  it("keeps the source as an owner after abort and then deleting the target", () => {
    const f = setup();
    enqueue(f.db, f.source.id, "a", { content: attach(f) });
    const x = retired(f);
    f.db.$client
      .prepare("DELETE FROM project_attachment_threads WHERE thread_id = ?")
      .run(f.source.id);
    expect(abort(f, x).kind).toBe("aborted");
    expect(owners(f)).toContain(f.source.id);
    deleteThread(f.db, noopNotifier, f.target.id);
    expect(owners(f)).toEqual([f.source.id]);
    expect(unowned(f)).toEqual({ n: 0 });
  });

  it("gives the source ownership for a redirected arrival returned by abort", () => {
    const f = setup();
    const content = attach(f);
    enqueue(f.db, f.source.id, "a");
    const x = retired(f);
    post(f, f.source.id, "late", content);
    f.db.$client
      .prepare("DELETE FROM project_attachment_threads WHERE thread_id = ?")
      .run(f.source.id);
    expect(abort(f, x).kind).toBe("aborted");
    deleteThread(f.db, noopNotifier, f.target.id);
    expect(owners(f)).toEqual([f.source.id]);
    expect(unowned(f)).toEqual({ n: 0 });
  });

  it("leaves the target as owner after a slot fill and deleting the source", () => {
    const f = setup();
    const a = enqueue(f.db, f.source.id, "a", { content: attach(f) });
    const claimed = claim(f, a.id);
    retired(f);
    release(f, a.id, claimed.claimToken);
    deleteThread(f.db, noopNotifier, f.source.id);
    expect(owners(f)).toEqual([f.target.id]);
    expect(unowned(f)).toEqual({ n: 0 });
  });

  it("refuses the whole abort when a returning attachment is claimed for deletion", () => {
    const f = setup();
    enqueue(f.db, f.source.id, "a", { content: attach(f) });
    const x = retired(f);
    f.db.$client
      .prepare("UPDATE project_attachments SET deletion_claimed_at = 1")
      .run();
    f.db.$client
      .prepare("DELETE FROM project_attachment_threads WHERE thread_id = ?")
      .run(f.source.id);
    expect(abort(f, x)).toEqual({
      kind: "refused",
      reason: "attachment_unavailable",
    });
    expect(allRows(f, f.source.id)).toEqual([]);
    expect(allRows(f, f.target.id)).toHaveLength(1);
    expect(redirectCount(f)).toBe(1);
  });
});
