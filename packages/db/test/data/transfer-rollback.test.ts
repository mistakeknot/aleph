import { describe, expect, it } from "vitest";
import {
  drainTransferEvents,
  ackTransferOperation,
  getDowngradeReadiness,
  releaseAllWorkerClaimsOffline,
} from "../../src/data/transfer-operations.js";
import {
  abort,
  allRows,
  claim,
  enqueue,
  entries,
  retire,
  setup,
} from "../helpers/retire-fixture.js";

describe("offline release (T-RB2)", () => {
  it("releases every worker claim, which fills every slot", () => {
    const f = setup();
    const a = enqueue(f.db, f.source.id, "a");
    const b = enqueue(f.db, f.source.id, "b");
    enqueue(f.db, f.source.id, "c");
    claim(f, a.id);
    claim(f, b.id);
    const outcome = retire(f);
    if (outcome.kind !== "retired") throw new Error(outcome.kind);
    const released = releaseAllWorkerClaimsOffline(f.db);
    expect(released.released).toBe(2);
    expect(
      allRows(f, f.target.id).filter((row) => row.forwardSourceRowId !== null),
    ).toEqual([]);
    expect(allRows(f, f.source.id)).toEqual([]);
    expect(
      entries(f, outcome.operationId).filter((e) => e.kind === "slot").map((e) => e.state),
    ).toEqual(["forwarded", "forwarded"]);
  });

  it("does nothing when there are no claims", () => {
    const f = setup();
    enqueue(f.db, f.source.id, "a");
    expect(releaseAllWorkerClaimsOffline(f.db).released).toBe(0);
  });
});

describe("downgrade readiness (T-RB3)", () => {
  it("is ready on an empty database", () => {
    expect(getDowngradeReadiness(setup().db).ready).toBe(true);
  });

  it("reports each non-zero count and is not ready", () => {
    const f = setup();
    const a = enqueue(f.db, f.source.id, "a");
    claim(f, a.id);
    const outcome = retire(f);
    if (outcome.kind !== "retired") throw new Error(outcome.kind);
    const busy = getDowngradeReadiness(f.db);
    expect(busy).toMatchObject({
      slots: 1,
      pendingEntries: 1,
      redirects: 1,
      unackedReceipts: 1,
      ready: false,
    });
    expect(busy.unemittedEvents).toBeGreaterThan(0);
    releaseAllWorkerClaimsOffline(f.db);
    const aborted = abort(f, outcome.operationId);
    if (aborted.kind !== "aborted") throw new Error(aborted.kind);
    const afterAbort = getDowngradeReadiness(f.db);
    expect(afterAbort).toMatchObject({
      slots: 0,
      pendingEntries: 0,
      redirects: 0,
      ready: false,
    });
    drainTransferEvents(f.db, () => undefined);
    ackTransferOperation(f.db, outcome.operationId, f.project.id);
    ackTransferOperation(f.db, aborted.operationId, f.project.id);
    expect(getDowngradeReadiness(f.db)).toEqual({
      slots: 0,
      pendingEntries: 0,
      unemittedEvents: 0,
      redirects: 0,
      nullOrigins: 0,
      unackedReceipts: 0,
      ready: true,
    });
  });

  it("refuses on a null origin", () => {
    const f = setup();
    const a = enqueue(f.db, f.source.id, "a");
    f.db.$client
      .prepare("UPDATE queued_thread_messages SET origin_id = NULL WHERE id = ?")
      .run(a.id);
    expect(getDowngradeReadiness(f.db)).toMatchObject({
      nullOrigins: 1,
      ready: false,
    });
  });

  it("refuses on an unacked receipt alone", () => {
    const f = setup();
    enqueue(f.db, f.source.id, "a");
    const outcome = retire(f);
    if (outcome.kind !== "retired") throw new Error(outcome.kind);
    abort(f, outcome.operationId);
    drainTransferEvents(f.db, () => undefined);
    expect(getDowngradeReadiness(f.db)).toMatchObject({
      unackedReceipts: 2,
      redirects: 0,
      ready: false,
    });
  });
});
