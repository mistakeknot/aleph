import { describe, expect, it } from "vitest";
import { noopNotifier } from "../../src/notifier.js";
import {
  releaseQueuedMessageClaim,
  requeueClaimedQueuedThreadMessages,
  sweepStaleQueuedMessageClaims,
} from "../../src/data/queued-thread-messages.js";
import { allRows, claim, enqueue, retire, setup } from "../helpers/retire-fixture.js";

const waits = {
  plugin: { kind: "plugin", pluginId: "holder", reason: "approval" },
  time: { kind: "time" },
} as const;

describe("slot waits survive claim exit (T1)", () => {
  for (const kind of ["plugin", "time"] as const) {
    it(`keeps a ${kind} wait on the filled slot after release`, () => {
      const f = setup();
      const sendAt = Date.now() + 60000;
      const a = enqueue(f.db, f.source.id, "held", {
        waitingOn: waits[kind],
        sendAt,
      });
      const claimed = claim(f, a.id);
      retire(f);
      releaseQueuedMessageClaim(f.db, noopNotifier, {
        id: a.id,
        claimToken: claimed.claimToken,
      });
      const row = allRows(f, f.target.id)[0];
      expect(JSON.parse(row?.waitingOn ?? "null")).toEqual(waits[kind]);
      expect(row?.waitHolder ?? null).toBe(
        kind === "plugin" ? "plugin:holder" : null,
      );
      expect(row?.sendAt).toBe(sendAt);
    });
  }

  it("carries the requeued wait onto the filled slot and reports the landing row", () => {
    const f = setup();
    const a = enqueue(f.db, f.source.id, "held");
    const claimed = claim(f, a.id);
    retire(f);
    const sendAt = Date.now() + 60000;
    const result = requeueClaimedQueuedThreadMessages(f.db, noopNotifier, {
      threadId: f.source.id,
      claims: [{ id: a.id, claimToken: claimed.claimToken }],
      waitingOn: { kind: "plugin", pluginId: "new-holder", reason: "blocked" },
      sendAt,
    });
    const row = allRows(f, f.target.id)[0];
    expect(JSON.parse(row?.waitingOn ?? "null")).toMatchObject({
      kind: "plugin",
      pluginId: "new-holder",
    });
    expect(row?.waitHolder).toBe("plugin:new-holder");
    expect(row?.sendAt).toBe(sendAt);
    expect(result?.id).toBe(row?.id);
    expect(result?.threadId).toBe(f.target.id);
  });

  it("recomputes a source-thread wait against the slot thread", () => {
    const f = setup();
    const a = enqueue(f.db, f.source.id, "held");
    const claimed = claim(f, a.id);
    retire(f);
    requeueClaimedQueuedThreadMessages(f.db, noopNotifier, {
      threadId: f.source.id,
      claims: [{ id: a.id, claimToken: claimed.claimToken }],
      waitingOn: { kind: "interaction" },
      sendAt: null,
    });
    const row = allRows(f, f.target.id)[0];
    expect(JSON.parse(row?.waitingOn ?? "null")).toEqual({
      kind: "thread-busy",
    });
    expect(row?.waitHolder ?? null).toBeNull();
  });

  it("keeps the wait when the stale sweep clears the source claim", () => {
    const f = setup();
    const a = enqueue(f.db, f.source.id, "held", { waitingOn: waits.plugin });
    claim(f, a.id);
    retire(f);
    sweepStaleQueuedMessageClaims(f.db, {
      claimedBefore: Date.now() + 1000,
      protectedClaimTokens: [],
    });
    const row = allRows(f, f.target.id)[0];
    expect(JSON.parse(row?.waitingOn ?? "null")).toEqual(waits.plugin);
  });
});
