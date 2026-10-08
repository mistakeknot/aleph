import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createConnection } from "../../src/index.js";
import { noopNotifier } from "../../src/notifier.js";
import {
  abortTransferOperation,
  retireQueuedThreadMessages,
} from "../../src/data/transfer-operations.js";
import { claimQueuedThreadMessage } from "../../src/data/queued-thread-messages.js";
import { resolveWaitingOn } from "../helpers/retire-fixture.js";
import {
  getQueuedThreadMessage,
  releaseQueuedMessageClaim,
  releaseStaleQueuedMessageClaims,
} from "../../src/data/queued-thread-messages.js";
import type { DbNotifier } from "../../src/notifier.js";
import {
  allRows,
  claim,
  enqueue,
  entries,
  retire,
  setup,
} from "../helpers/retire-fixture.js";
import type { Fixture } from "../helpers/retire-fixture.js";

function recordingNotifier() {
  const notified: string[] = [];
  const notifier = {
    notifyThread: (threadId: string) => {
      notified.push(threadId);
    },
  } as unknown as DbNotifier;
  return { notifier, notified };
}

function ageClaims(f: Fixture, claimedAt = 1) {
  f.db.$client
    .prepare("UPDATE queued_thread_messages SET claimed_at = ?")
    .run(claimedAt);
}

function sweepArgs(protectedClaimTokens: string[] = []) {
  return { claimedBefore: Date.now() + 60_000, protectedClaimTokens };
}

describe("worker-claim predicate (T-RC1, T-RC3)", () => {
  it("T-RC1 releases an unrelated stale claim and leaves a protected source and its slot pending", () => {
    const f = setup();
    const other = f.make();
    const a = enqueue(f.db, f.source.id, "a");
    const claimedA = claim(f, a.id);
    const u = enqueue(f.db, other.id, "u");
    claim(f, u.id);
    const outcome = retire(f);
    if (outcome.kind !== "retired") throw new Error(outcome.kind);
    ageClaims(f);
    const { notifier } = recordingNotifier();
    const released = releaseStaleQueuedMessageClaims(
      f.db,
      notifier,
      sweepArgs([claimedA.claimToken]),
    );
    expect(released).toBe(1);
    expect(getQueuedThreadMessage(f.db, u.id)?.claimedAt).toBeNull();
    expect(getQueuedThreadMessage(f.db, a.id)?.claimedAt).not.toBeNull();
    const slots = allRows(f, f.target.id);
    expect(slots).toHaveLength(1);
    expect(slots[0]?.claimToken).toBe(`slot:${a.id}`);
    expect(entries(f, outcome.operationId)[0]?.state).toBe("pending");
  });

  it("T-RC1 never selects aged slots alone", () => {
    const f = setup();
    const a = enqueue(f.db, f.source.id, "a");
    const claimedA = claim(f, a.id);
    retire(f);
    ageClaims(f);
    const { notifier } = recordingNotifier();
    expect(
      releaseStaleQueuedMessageClaims(
        f.db,
        notifier,
        sweepArgs([claimedA.claimToken]),
      ),
    ).toBe(0);
    expect(allRows(f, f.target.id)[0]?.claimToken).toBe(`slot:${a.id}`);
  });

  it("T-RC2 an unprotected stale source is released, its slot fills and the destination is notified", () => {
    const f = setup();
    const a = enqueue(f.db, f.source.id, "a");
    claim(f, a.id);
    const outcome = retire(f);
    if (outcome.kind !== "retired") throw new Error(outcome.kind);
    ageClaims(f);
    const { notifier, notified } = recordingNotifier();
    expect(releaseStaleQueuedMessageClaims(f.db, notifier, sweepArgs())).toBe(
      1,
    );
    expect(getQueuedThreadMessage(f.db, a.id)).toBeNull();
    const filled = allRows(f, f.target.id);
    expect(filled).toHaveLength(1);
    expect(filled[0]).toMatchObject({ claimToken: null, claimedAt: null });
    expect(entries(f, outcome.operationId)[0]?.state).toBe("forwarded");
    expect(new Set(notified)).toEqual(new Set([f.source.id, f.target.id]));
  });

  it("T-RC3 token release and requeue by slot token or no token touch no slot", () => {
    const f = setup();
    const a = enqueue(f.db, f.source.id, "a");
    claim(f, a.id);
    retire(f);
    const [slot] = allRows(f, f.target.id);
    if (!slot) throw new Error("no slot");
    const { notifier } = recordingNotifier();
    expect(
      releaseQueuedMessageClaim(f.db, notifier, {
        id: slot.id,
        claimToken: `slot:${a.id}`,
      }),
    ).toBe(false);
    expect(allRows(f, f.target.id)[0]?.claimToken).toBe(`slot:${a.id}`);
  });

  it("T-RC3 the unguarded statement still raises on a slot", () => {
    const f = setup();
    const a = enqueue(f.db, f.source.id, "a");
    claim(f, a.id);
    retire(f);
    expect(() =>
      f.db.$client
        .prepare(
          "UPDATE queued_thread_messages SET claimed_at = NULL, claim_token = NULL WHERE forward_source_row_id IS NOT NULL",
        )
        .run(),
    ).toThrow();
  });
});

describe("transactional sweep (T-RC4, T-RC5)", () => {
  it("T-RC4 a fault between the selection and the update rolls the whole sweep back", () => {
    const f = setup();
    const a = enqueue(f.db, f.source.id, "a");
    claim(f, a.id);
    retire(f);
    ageClaims(f);
    f.db.$client.exec(
      `CREATE TRIGGER fault_sweep BEFORE UPDATE OF claimed_at ON queued_thread_messages
       WHEN NEW.claimed_at IS NULL AND OLD.forward_source_row_id IS NULL
       BEGIN SELECT RAISE(ABORT, 'injected'); END`,
    );
    const { notifier, notified } = recordingNotifier();
    expect(() =>
      releaseStaleQueuedMessageClaims(f.db, notifier, sweepArgs()),
    ).toThrow(/injected/);
    expect(notified).toEqual([]);
    expect(getQueuedThreadMessage(f.db, a.id)?.claimedAt).not.toBeNull();
    expect(allRows(f, f.target.id)[0]?.claimToken).toBe(`slot:${a.id}`);
  });

  it("T-RC4 a second connection cannot write between the stale selection and the update", () => {
    const f = setup();
    const a = enqueue(f.db, f.source.id, "a");
    claim(f, a.id);
    enqueue(f.db, f.source.id, "other");
    retire(f);
    ageClaims(f);
    const dir = mkdtempSync(join(tmpdir(), "rc4-window-"));
    const file = join(dir, "bb.db");
    f.db.$client.pragma("wal_checkpoint(TRUNCATE)");
    writeFileSync(file, f.db.$client.serialize());
    const first = createConnection(file);
    const second = createConnection(file);
    second.$client.pragma("busy_timeout = 0");
    const write = () =>
      second.$client
        .prepare("UPDATE threads SET title = ? WHERE id = ?")
        .run("second", f.target.id);
    expect(write).not.toThrow();
    const prepare = first.$client.prepare.bind(first.$client);
    let attempted = false;
    let code = "";
    const spy = vi.spyOn(first.$client, "prepare").mockImplementation(((
      sql: string,
    ) => {
      const statement = prepare(sql);
      if (
        sql.startsWith(
          'select "id", "thread_id" from "queued_thread_messages"',
        ) &&
        sql.includes('"claimed_at"')
      ) {
        const all = statement.all.bind(statement);
        statement.all = ((...args: unknown[]) => {
          const rows = all(...args);
          attempted = true;
          try {
            write();
            code = "ran";
          } catch (error) {
            code = (error as { code?: string }).code ?? String(error);
          }
          return rows;
        }) as typeof statement.all;
      }
      return statement;
    }) as typeof first.$client.prepare);
    try {
      releaseStaleQueuedMessageClaims(first, noopNotifier, sweepArgs());
    } finally {
      spy.mockRestore();
      first.$client.close();
      second.$client.close();
      rmSync(dir, { recursive: true, force: true });
    }
    expect(attempted).toBe(true);
    expect(code).toBe("SQLITE_BUSY");
  });

  it("T-RC5 releases more claims than the driver bind cap in one sweep and fills the slot", () => {
    const f = setup();
    const a = enqueue(f.db, f.source.id, "a");
    claim(f, a.id);
    retire(f);
    const bulk = f.make();
    f.db.$client
      .prepare(
        `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 33000)
         INSERT INTO queued_thread_messages
           (id, thread_id, content, model, reasoning_level, permission_mode, service_tier,
            group_with_next, payload_kind, claimed_at, claim_token, sort_key, created_at, updated_at)
         SELECT 'qmsg_bulk' || i, ?, '[]', 'm', 'r', 'full', 'default', 0, 'inline',
                1, 'tok' || i, printf('k%08d', i), 1, 1 FROM n`,
      )
      .run(bulk.id);
    ageClaims(f);
    const { notifier, notified } = recordingNotifier();
    const released = releaseStaleQueuedMessageClaims(f.db, notifier, {
      claimedBefore: Date.now() + 60_000,
      protectedClaimTokens: ["tok1", "tok2", "tok3"],
    });
    expect(released).toBe(33000 - 3 + 1);
    expect(getQueuedThreadMessage(f.db, a.id)).toBeNull();
    expect(allRows(f, f.target.id)[0]?.claimToken).toBeNull();
    expect(new Set(notified)).toEqual(
      new Set([f.source.id, f.target.id, bulk.id]),
    );
  }, 60_000);
  it("T-RC4 a second connection's retire, claim, release and abort block while the sweep runs", () => {
    const f = setup();
    const a = enqueue(f.db, f.source.id, "a");
    const claimedA = claim(f, a.id);
    const op = retire(f);
    if (op.kind !== "retired") throw new Error(op.kind);
    const free = enqueue(f.db, f.source.id, "free");
    ageClaims(f);
    const dir = mkdtempSync(join(tmpdir(), "rc4-"));
    const file = join(dir, "bb.db");
    f.db.$client.pragma("wal_checkpoint(TRUNCATE)");
    writeFileSync(file, f.db.$client.serialize());
    const first = createConnection(file);
    const second = createConnection(file);
    second.$client.pragma("busy_timeout = 0");
    second.$client.function("probe_second", () => 1);
    const outcomes: Record<string, string> = {};
    const attempt = (name: string, run: () => unknown) => {
      try {
        run();
        outcomes[name] = "ran";
      } catch (error) {
        outcomes[name] = (error as { code?: string }).code ?? String(error);
      }
    };
    first.$client.function("probe_second", () => {
      attempt("retire", () =>
        retireQueuedThreadMessages(second, {
          projectId: f.project.id,
          sourceThreadId: f.source.id,
          targetThreadId: f.target.id,
          operationKey: "second-retire",
          retireEnabled: true,
          resolveWaitingOn,
        }),
      );
      attempt("claim", () =>
        claimQueuedThreadMessage(second, noopNotifier, free.id),
      );
      attempt("release", () =>
        releaseQueuedMessageClaim(second, noopNotifier, {
          id: a.id,
          claimToken: claimedA.claimToken,
        }),
      );
      attempt("abort", () =>
        abortTransferOperation(second, {
          projectId: f.project.id,
          operationId: op.operationId,
          expectedRetirementOperationId: op.operationId,
          operationKey: "second-abort",
          resolveWaitingOn,
        }),
      );
      return 1;
    });
    first.$client.exec(
      `CREATE TRIGGER probe_sweep BEFORE UPDATE OF claimed_at ON queued_thread_messages
       WHEN NEW.claimed_at IS NULL AND OLD.forward_source_row_id IS NULL
       BEGIN SELECT probe_second(); END`,
    );
    try {
      releaseStaleQueuedMessageClaims(first, noopNotifier, sweepArgs());
    } finally {
      first.$client.close();
      second.$client.close();
      rmSync(dir, { recursive: true, force: true });
    }
    expect(outcomes).toEqual({
      retire: "SQLITE_BUSY",
      claim: "SQLITE_BUSY",
      release: "SQLITE_BUSY",
      abort: "SQLITE_BUSY",
    });
  });
});
