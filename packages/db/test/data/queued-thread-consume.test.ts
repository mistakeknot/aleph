import { describe, expect, it } from "vitest";
import { noopNotifier } from "../../src/notifier.js";
import {
  claimQueuedThreadMessageIdsInTransaction,
  createQueuedThreadMessage,
  deleteClaimedQueuedThreadMessageBatchInTransaction,
  getQueuedThreadMessage,
} from "../../src/data/queued-thread-messages.js";
import { allRows, claim, enqueue, release, retire, setup } from "../helpers/retire-fixture.js";

describe("consume guard (T-C1 db layer)", () => {
  it("refuses to consume a claimed row that owns a live slot and leaves it claimed", () => {
    const f = setup();
    const a = enqueue(f.db, f.source.id, "a");
    const claimed = claim(f, a.id);
    const outcome = retire(f);
    if (outcome.kind !== "retired") throw new Error(outcome.kind);
    const consumed = f.db.transaction((tx) =>
      deleteClaimedQueuedThreadMessageBatchInTransaction(tx, {
        queuedMessages: [claimed],
      }),
    );
    expect(consumed).toBe(false);
    expect(getQueuedThreadMessage(f.db, a.id)).toMatchObject({
      claimToken: claimed.claimToken,
    });
    expect(allRows(f, f.target.id)).toHaveLength(1);
  });

  it("still consumes an ordinary claimed row", () => {
    const f = setup();
    const a = enqueue(f.db, f.source.id, "a");
    const claimed = claim(f, a.id);
    expect(
      f.db.transaction((tx) =>
        deleteClaimedQueuedThreadMessageBatchInTransaction(tx, {
          queuedMessages: [claimed],
        }),
      ),
    ).toBe(true);
    expect(getQueuedThreadMessage(f.db, a.id)).toBeNull();
  });

  it("lets the release path fill the slot after a refused consume", () => {
    const f = setup();
    const a = enqueue(f.db, f.source.id, "a");
    const claimed = claim(f, a.id);
    retire(f);
    f.db.transaction((tx) =>
      deleteClaimedQueuedThreadMessageBatchInTransaction(tx, {
        queuedMessages: [claimed],
      }),
    );
    release(f, a.id, claimed.claimToken);
    expect(allRows(f, f.target.id)[0]).toMatchObject({
      claimedAt: null,
      forwardSourceRowId: null,
    });
    expect(getQueuedThreadMessage(f.db, a.id)).toBeNull();
  });
});

describe("all-or-none group claim (T-B1 db layer)", () => {
  it("persists nothing when one member of the id set is already claimed", () => {
    const f = setup();
    const a = enqueue(f.db, f.source.id, "a");
    const b = enqueue(f.db, f.source.id, "b");
    claim(f, b.id);
    expect(() =>
      f.db.transaction((tx) =>
        claimQueuedThreadMessageIdsInTransaction(tx, [a.id, b.id]),
      ),
    ).toThrow(/short_claim/);
    expect(getQueuedThreadMessage(f.db, a.id)).toMatchObject({
      claimedAt: null,
      claimToken: null,
    });
  });

  it("claims the whole set when every member is free", () => {
    const f = setup();
    const a = enqueue(f.db, f.source.id, "a");
    const b = enqueue(f.db, f.source.id, "b");
    const rows = f.db.transaction((tx) =>
      claimQueuedThreadMessageIdsInTransaction(tx, [a.id, b.id]),
    );
    expect(rows?.map((r) => r.id)).toEqual([a.id, b.id]);
  });

  it("does not count a slot as claimable", () => {
    const f = setup();
    const a = enqueue(f.db, f.source.id, "a");
    claim(f, a.id);
    retire(f);
    const slot = allRows(f, f.target.id)[0]!;
    expect(() =>
      f.db.transaction((tx) =>
        claimQueuedThreadMessageIdsInTransaction(tx, [slot.id]),
      ),
    ).toThrow(/short_claim/);
  });
});

describe("literal placement (T-G5a/b/c)", () => {
  function order(f: ReturnType<typeof setup>, threadId: string) {
    return allRows(f, threadId).map((r) => r.originId);
  }

  it("T-G5a places forwarded rows after existing target rows in source order for every release order", () => {
    for (const releaseOrder of [
      [0, 1],
      [1, 0],
    ]) {
      const f = setup();
      const t = enqueue(f.db, f.target.id, "t");
      const a = enqueue(f.db, f.source.id, "a");
      const b = enqueue(f.db, f.source.id, "b");
      const c = enqueue(f.db, f.source.id, "c");
      const d = enqueue(f.db, f.source.id, "d");
      const claimedA = claim(f, a.id);
      const claimedC = claim(f, c.id);
      retire(f);
      const expected = [t.id, a.id, b.id, c.id, d.id];
      expect(order(f, f.target.id)).toEqual(expected);
      const claims = [claimedA, claimedC];
      for (const index of releaseOrder) {
        release(f, claims[index]!.id, claims[index]!.claimToken);
        expect(order(f, f.target.id)).toEqual(expected);
      }
    }
  });

  it("T-G5b keeps placement across bulk calls", () => {
    const f = setup();
    const other = f.make();
    const t = enqueue(f.db, f.target.id, "t");
    const a = enqueue(f.db, f.source.id, "a");
    const x = enqueue(f.db, other.id, "x");
    const b = enqueue(f.db, f.source.id, "b");
    const claimedA = claim(f, a.id);
    retire(f);
    const second = retire(f, {
      sourceThreadId: other.id,
      operationKey: "key-2",
    });
    expect(second.kind).toBe("retired");
    expect(order(f, f.target.id)).toEqual([t.id, a.id, b.id, x.id]);
    release(f, claimedA.id, claimedA.claimToken);
    expect(order(f, f.target.id)).toEqual([t.id, a.id, b.id, x.id]);
  });

  it("T-G5c keeps placement along a chain with a late arrival", () => {
    const f = setup();
    const a = enqueue(f.db, f.source.id, "a");
    const b = enqueue(f.db, f.source.id, "b");
    const claimedA = claim(f, a.id);
    retire(f);
    const late = createQueuedThreadMessage(f.db, noopNotifier, {
      threadId: f.source.id,
      content: [{ type: "text", text: "late", mentions: [] }],
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: null,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });
    expect(order(f, f.target.id)).toEqual([a.id, b.id, late.id]);
    release(f, claimedA.id, claimedA.claimToken);
    expect(order(f, f.target.id)).toEqual([a.id, b.id, late.id]);
  });
});
