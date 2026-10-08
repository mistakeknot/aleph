import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import type { PromptInput } from "@bb/domain";
import { createConnection } from "../../src/connection.js";
import { migrate } from "../../src/migrate.js";
import { noopNotifier } from "../../src/notifier.js";
import { upsertHost } from "../../src/data/hosts.js";
import { createProject } from "../../src/data/projects.js";
import {
  archiveThread,
  createThread,
  deleteThread,
} from "../../src/data/threads.js";
import {
  claimQueuedThreadMessage,
  createQueuedThreadMessage,
  createQueuedThreadMessageInTransaction,
  getQueuedThreadMessage,
  listQueuedThreadMessages,
  reorderQueuedThreadMessage,
  transferAllQueuedThreadMessagesInTransaction,
  transferQueuedThreadMessageInTransaction,
} from "../../src/data/queued-thread-messages.js";
import { createOrderKeysAfter } from "../../src/data/order-keys.js";
import { recordProjectAttachment } from "../../src/data/project-attachments.js";
import {
  RETIRE_MAX_SOURCE_QUEUE_ROWS,
  ackTransferOperation,
  drainTransferEvents,
  getTransferOperation,
  retireQueuedThreadMessages,
  sweepTransferOperations,
} from "../../src/data/transfer-operations.js";
import { createMigratedConnection } from "../helpers/migrated-connection.js";

function textInput(text: string): PromptInput[] {
  return [{ type: "text", text, mentions: [] }];
}

function setup() {
  const db = createMigratedConnection();
  const host = upsertHost(db, noopNotifier, { name: "test-host" });
  const { project } = createProject(db, noopNotifier, {
    name: "test-project",
    source: { type: "local_path", hostId: host.id, path: "/tmp/test" },
  });
  const make = () =>
    createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
    });
  return { db, host, project, source: make(), target: make(), make };
}

function enqueue(
  db: ReturnType<typeof createMigratedConnection>,
  threadId: string,
  text: string,
  overrides: Partial<Parameters<typeof createQueuedThreadMessage>[2]> = {},
) {
  return createQueuedThreadMessage(db, noopNotifier, {
    threadId,
    content: textInput(text),
    model: "gpt-5",
    reasoningLevel: "medium",
    permissionMode: "full",
    serviceTier: "default",
    waitingOn: null,
    sendAt: null,
    payload: { kind: "inline" },
    systemNotice: null,
    ...overrides,
  });
}

const resolveWaitingOn = () => ({ kind: "thread-busy" }) as const;

function retire(
  fixture: ReturnType<typeof setup>,
  overrides: Partial<Parameters<typeof retireQueuedThreadMessages>[1]> = {},
) {
  return retireQueuedThreadMessages(fixture.db, {
    projectId: fixture.project.id,
    sourceThreadId: fixture.source.id,
    targetThreadId: fixture.target.id,
    operationKey: "key-1",
    retireEnabled: true,
    resolveWaitingOn,
    ...overrides,
  });
}

function texts(
  db: ReturnType<typeof createMigratedConnection>,
  threadId: string,
) {
  return listQueuedThreadMessages(db, threadId).map(
    (row) => (JSON.parse(row.content) as PromptInput[])[0],
  );
}

describe("origin identity (T-O3 and T-L1; v4 T-O1/T-O2 are outbox tests and are not covered here)", () => {
  it("returns the supplied origin and stores it", () => {
    const { db, source } = setup();
    const row = enqueue(db, source.id, "a");
    expect(row.originId).toBe(row.id);
    expect(getQueuedThreadMessage(db, row.id)?.originId).toBe(row.id);
  });

  it("carries a supplied origin and fails closed on a duplicate live origin", () => {
    const { db, source, target } = setup();
    const row = enqueue(db, source.id, "a");
    expect(() => enqueue(db, target.id, "dup", { originId: row.id })).toThrow(
      /UNIQUE/,
    );
    expect(listQueuedThreadMessages(db, target.id)).toEqual([]);
  });

  it("mints an origin for an insert that omits the column and reports NULL from RETURNING", () => {
    const { db, source } = setup();
    const returned = db.$client
      .prepare(
        `INSERT INTO queued_thread_messages (id, thread_id, content, model, reasoning_level, permission_mode, service_tier, group_with_next, payload_kind, failure_count, sort_key, created_at, updated_at)
         VALUES ('qmsg_old', ?, '[]', 'm', 'r', 'full', 'default', 0, 'inline', 0, 'a0', 1, 1) RETURNING origin_id`,
      )
      .get(source.id) as { origin_id: string | null };
    expect(returned.origin_id).toBeNull();
    expect(getQueuedThreadMessage(db, "qmsg_old")?.originId).toBe("qmsg_old");
  });

  it("backfills origin_id for rows that exist before the migration", () => {
    const { db, source } = setup();
    const row = enqueue(db, source.id, "a");
    db.$client
      .prepare(
        "UPDATE queued_thread_messages SET origin_id = NULL WHERE id = ?",
      )
      .run(row.id);
    expect(getQueuedThreadMessage(db, row.id)?.originId).toBeNull();
    const sql = readFileSync(
      new URL("../../drizzle/0135_fixed_imperial_guard.sql", import.meta.url),
      "utf8",
    );
    const backfill = sql
      .split("--> statement-breakpoint")
      .map((statement) => statement.trim())
      .find((statement) => statement.startsWith("UPDATE `queued_thread_messages`"));
    expect(backfill).toBeDefined();
    db.$client.prepare(backfill ?? "").run();
    expect(getQueuedThreadMessage(db, row.id)?.originId).toBe(row.id);
  });

  it("rolls back when RETURNING disagrees with the supplied origin", () => {
    const { db, source } = setup();
    const tamper = (tx: Parameters<typeof createQueuedThreadMessageInTransaction>[0]) =>
      new Proxy(tx, {
        get(target, property, receiver) {
          if (property !== "insert") return Reflect.get(target, property, receiver);
          return (table: unknown) => {
            const builder = (target.insert as (t: unknown) => unknown)(table) as {
              values: (v: Record<string, unknown>) => unknown;
            };
            return {
              values: (v: Record<string, unknown>) =>
                builder.values(
                  "originId" in v ? { ...v, originId: "qmsg_tampered" } : v,
                ),
            };
          };
        },
      });
    expect(() =>
      db.transaction(
        (tx) =>
          createQueuedThreadMessageInTransaction(tamper(tx), {
            threadId: source.id,
            originId: "qmsg_expected",
            content: textInput("a"),
            model: "gpt-5",
            reasoningLevel: "medium",
            permissionMode: "full",
            serviceTier: "default",
            waitingOn: null,
            sendAt: null,
            payload: { kind: "inline" },
            systemNotice: null,
          }),
        { behavior: "immediate" },
      ),
    ).toThrow(/instead of qmsg_expected/);
    expect(listQueuedThreadMessages(db, source.id)).toEqual([]);
  });

  it("makes legacy transfer delete-first and carries the origin", () => {
    const { db, source, target } = setup();
    const row = enqueue(db, source.id, "a");
    const result = db.transaction(
      (tx) =>
        transferQueuedThreadMessageInTransaction(tx, {
          queuedMessageId: row.id,
          sourceThreadId: source.id,
          targetThreadId: target.id,
          resolveWaitingOn,
        }),
      { behavior: "immediate" },
    );
    expect(result.kind).toBe("transferred");
    if (result.kind !== "transferred") return;
    expect(result.queuedMessage.id).not.toBe(row.id);
    expect(result.queuedMessage.originId).toBe(row.id);
    expect(getQueuedThreadMessage(db, row.id)).toBeNull();
    expect(listQueuedThreadMessages(db, source.id)).toEqual([]);
    const live = db.$client
      .prepare(
        "SELECT COUNT(*) AS n FROM queued_thread_messages WHERE origin_id = ?",
      )
      .get(row.id) as { n: number };
    expect(live.n).toBe(1);
  });

  it("keeps the transfer-all result shape and skips claimed rows ", () => {
    const { db, source, target } = setup();
    const a = enqueue(db, source.id, "a");
    const claimed = enqueue(db, source.id, "b");
    const notInline = enqueue(db, source.id, "c", {
      payload: {
        kind: "retry",
        retryOfTurnRequestId: "req",
        attempt: 2,
        reason: "rate",
      },
    });
    claimQueuedThreadMessage(db, noopNotifier, claimed.id);
    const result = db.transaction(
      (tx) =>
        transferAllQueuedThreadMessagesInTransaction(tx, {
          sourceThreadId: source.id,
          targetThreadId: target.id,
          resolveWaitingOn,
        }),
      { behavior: "immediate" },
    );
    expect(result.moved.map((entry) => entry.id)).toEqual([a.id]);
    expect(result.skipped).toEqual([
      { id: claimed.id, reason: "claimed" },
      { id: notInline.id, reason: "not_inline" },
    ]);
    expect(result.moved[0]?.queuedMessage.originId).toBe(a.id);
  });
});

describe("retire, moves only (G3 behavior; v4 T-T/T-C/T-I/T-R0 definitions are slot or redirect tests deferred to increment 4; T-E1 is covered only in part, by the 10k time bound and the route flows)", () => {
  it("moves unclaimed inline rows to the target tail in order and records one entry each", () => {
    const fixture = setup();
    const { db, source, target } = fixture;
    enqueue(db, target.id, "t1");
    const a = enqueue(db, source.id, "a");
    const b = enqueue(db, source.id, "b", {
      sendAt: 4_000_000_000_000,
      waitingOn: { kind: "time", sendAt: 4_000_000_000_000 } as never,
    });
    const retry = enqueue(db, source.id, "r", {
      payload: {
        kind: "retry",
        retryOfTurnRequestId: "req",
        attempt: 2,
        reason: "rate",
      },
    });
    const c = enqueue(db, source.id, "c");

    const outcome = retire(fixture);
    expect(outcome.kind).toBe("retired");
    if (outcome.kind !== "retired") return;

    expect(
      texts(db, target.id).map((item) => item?.type === "text" && item.text),
    ).toEqual(["t1", "a", "b", "c"]);
    expect(
      listQueuedThreadMessages(db, source.id).map((row) => row.id),
    ).toEqual([retry.id]);
    expect(outcome.result.moved.map((entry) => entry.id)).toEqual([
      a.id,
      b.id,
      c.id,
    ]);
    expect(outcome.result.moved.map((entry) => entry.originId)).toEqual([
      a.id,
      b.id,
      c.id,
    ]);
    expect(outcome.result.pending).toEqual([]);
    expect(outcome.result.notForwardable.map((entry) => entry.id)).toEqual([
      retry.id,
    ]);

    const moved = listQueuedThreadMessages(db, target.id).slice(1);
    expect(moved.map((row) => row.id)).toEqual(
      outcome.result.moved.map((entry) => entry.newId),
    );
    const movedB = moved[1];
    expect(movedB?.sendAt).toBe(4_000_000_000_000);
    expect(movedB?.model).toBe("gpt-5");
    expect(movedB?.permissionMode).toBe("full");
    expect(movedB?.claimedAt).toBeNull();
    expect(movedB?.forwardSourceRowId).toBeNull();

    const op = getTransferOperation(db, outcome.operationId);
    expect(op?.kind).toBe("retire");
    expect(op?.state).toBe("active");
    expect(op?.entries.map((entry) => [entry.kind, entry.state])).toEqual([
      ["moved", "terminal"],
      ["moved", "terminal"],
      ["not_forwardable", "terminal"],
      ["moved", "terminal"],
    ]);
  });

  it("orders the walk by (sort_key, id) after a reorder (T-R0)", () => {
    const fixture = setup();
    const { db, source, target } = fixture;
    const a = enqueue(db, source.id, "a");
    enqueue(db, source.id, "b");
    const c = enqueue(db, source.id, "c");
    reorderQueuedThreadMessage({
      db,
      notifier: noopNotifier,
      threadId: source.id,
      queuedMessageId: c.id,
      previousQueuedMessageId: null,
      nextQueuedMessageId: a.id,
    });
    const before = texts(db, source.id).map(
      (item) => item?.type === "text" && item.text,
    );
    const outcome = retire(fixture);
    expect(outcome.kind).toBe("retired");
    expect(
      texts(db, target.id).map((item) => item?.type === "text" && item.text),
    ).toEqual(before);
  });

  it("forwards a claimed inline row through a slot instead of refusing", () => {
    const fixture = setup();
    const { db, source, target } = fixture;
    enqueue(db, source.id, "a");
    const claimed = enqueue(db, source.id, "b");
    claimQueuedThreadMessage(db, noopNotifier, claimed.id);
    const outcome = retire(fixture);
    if (outcome.kind !== "retired") throw new Error(outcome.kind);
    expect(outcome.result.moved).toHaveLength(1);
    expect(outcome.result.pending).toEqual([
      { id: claimed.id, originId: claimed.id },
    ]);
    expect(texts(db, target.id)).toHaveLength(1);
    expect(
      db.$client
        .prepare(
          "SELECT COUNT(*) AS n FROM queued_thread_messages WHERE forward_source_row_id IS NOT NULL",
        )
        .get(),
    ).toEqual({ n: 1 });
  });

  it("forwards a claimed non-inline row as not forwardable, never a slot", () => {
    const fixture = setup();
    const { db, source, target } = fixture;
    enqueue(db, source.id, "a");
    const retry = enqueue(db, source.id, "b", {
      payload: {
        kind: "retry",
        retryOfTurnRequestId: "turn_1",
        attempt: 1,
        reason: "network",
      },
    });
    claimQueuedThreadMessage(db, noopNotifier, retry.id);
    const outcome = retire(fixture);
    if (outcome.kind !== "retired") throw new Error(outcome.kind);
    expect(outcome.result.notForwardable).toEqual([
      { id: retry.id, originId: retry.id },
    ]);
    expect(outcome.result.pending).toEqual([]);
    expect(texts(db, target.id)).toHaveLength(1);
    expect(
      db.$client
        .prepare(
          "SELECT COUNT(*) AS n FROM queued_thread_messages WHERE forward_source_row_id IS NOT NULL",
        )
        .get(),
    ).toEqual({ n: 0 });
  });

  it("holds the writer reservation from the first statement, excluding a second connection", () => {
    const dir = mkdtempSync(join(tmpdir(), "retire-lock-"));
    const file = join(dir, "db.sqlite");
    const db = createConnection(file);
    migrate(db);
    const second = new Database(file);
    second.pragma("busy_timeout = 0");
    try {
      const host = upsertHost(db, noopNotifier, { name: "h" });
      const { project } = createProject(db, noopNotifier, {
        name: "p",
        source: { type: "local_path", hostId: host.id, path: "/tmp/p" },
      });
      const a = createThread(db, noopNotifier, {
        projectId: project.id,
        providerId: "codex",
      });
      const b = createThread(db, noopNotifier, {
        projectId: project.id,
        providerId: "codex",
      });
      enqueue(db, a.id, "x");
      let blocked: unknown = null;
      const outcome = retireQueuedThreadMessages(db, {
        projectId: project.id,
        sourceThreadId: a.id,
        targetThreadId: b.id,
        operationKey: "k",
        retireEnabled: true,
        admitTarget: () => {
          try {
            second.prepare("BEGIN IMMEDIATE").run();
            second.prepare("ROLLBACK").run();
          } catch (error) {
            blocked = error;
          }
        },
        resolveWaitingOn,
      });
      expect(outcome.kind).toBe("retired");
      expect(String(blocked)).toMatch(/SQLITE_BUSY|locked/);
    } finally {
      second.close();
      db.$client.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("acquires the target's attachment ownership for moved rows and refuses whole when unavailable (T-M1)", () => {
    const fixture = setup();
    const { db, source, target, project } = fixture;
    recordProjectAttachment(db, {
      projectId: project.id,
      storedPath: "uploads/a.pdf",
      originalName: "a.pdf",
      mimeType: "application/pdf",
      sizeBytes: 1,
      createdAt: 1,
      readyAt: 1,
    });
    const withFile: PromptInput[] = [
      { type: "localFile", path: "uploads/a.pdf" } as PromptInput,
    ];
    enqueue(db, source.id, "x", { content: withFile });
    const outcome = retire(fixture);
    expect(outcome.kind).toBe("retired");
    const owners = db.$client
      .prepare(
        "SELECT thread_id FROM project_attachment_threads ORDER BY thread_id",
      )
      .all() as Array<{ thread_id: string }>;
    expect(owners.map((owner) => owner.thread_id)).toContain(target.id);

    const second = setup();
    recordProjectAttachment(second.db, {
      projectId: second.project.id,
      storedPath: "uploads/gone.pdf",
      originalName: "gone.pdf",
      mimeType: "application/pdf",
      sizeBytes: 1,
      createdAt: 1,
      readyAt: 1,
    });
    enqueue(second.db, second.source.id, "ok");
    enqueue(second.db, second.source.id, "y", {
      content: [{ type: "localFile", path: "uploads/gone.pdf" } as PromptInput],
    });
    second.db.$client
      .prepare("UPDATE project_attachments SET deletion_claimed_at = 1")
      .run();
    const refused = retire(second);
    expect(refused).toEqual({
      kind: "refused",
      reason: "attachment_unavailable",
    });
    expect(listQueuedThreadMessages(second.db, second.source.id)).toHaveLength(
      2,
    );
    expect(listQueuedThreadMessages(second.db, second.target.id)).toEqual([]);
    expect(
      second.db.$client
        .prepare("SELECT COUNT(*) AS n FROM transfer_operations")
        .get(),
    ).toEqual({ n: 0 });
  });

  it("refuses in the documented order", () => {
    const fixture = setup();
    const { db, source, target, make } = fixture;
    expect(retire(fixture, { targetThreadId: source.id })).toEqual({
      kind: "refused",
      reason: "self_transfer",
    });
    expect(retire(fixture, { sourceThreadId: "thr_missing" })).toEqual({
      kind: "refused",
      reason: "unknown_thread",
    });
    const deleted = make();
    db.$client
      .prepare("UPDATE threads SET deleted_at = 1 WHERE id = ?")
      .run(deleted.id);
    expect(retire(fixture, { sourceThreadId: deleted.id })).toEqual({
      kind: "refused",
      reason: "source_deleted",
    });
    const archived = make();
    archiveThread(db, noopNotifier, archived.id);
    expect(retire(fixture, { targetThreadId: archived.id })).toEqual({
      kind: "refused",
      reason: "thread_not_writable",
    });
    expect(retire(fixture, { targetThreadId: "thr_missing" })).toEqual({
      kind: "refused",
      reason: "thread_not_writable",
    });
    expect(retire(fixture, { retireEnabled: false })).toEqual({
      kind: "refused",
      reason: "transfer_retire_disabled",
    });
    void target;
    expect(
      db.$client.prepare("SELECT COUNT(*) AS n FROM transfer_operations").get(),
    ).toEqual({ n: 0 });
  });

  it("refuses from a thread that is already retired, a target that is retired, and a retire target", () => {
    const fixture = setup();
    const { db, source, target, make } = fixture;
    const other = make();
    db.$client
      .prepare(
        "INSERT INTO transfer_operations (id, project_id, operation_key, request_hash, kind, source_thread_id, target_thread_id, state, created_at) VALUES ('op_x', ?, 'k', 'h', 'retire', ?, ?, 'active', 1)",
      )
      .run(fixture.project.id, other.id, target.id);
    db.$client
      .prepare(
        "INSERT INTO thread_redirects (source_thread_id, successor_thread_id, op_id) VALUES (?, ?, 'op_x')",
      )
      .run(other.id, target.id);
    expect(
      retire(fixture, { sourceThreadId: other.id, targetThreadId: source.id }),
    ).toEqual({
      kind: "refused",
      reason: "already_retired",
    });
    expect(
      retire(fixture, { sourceThreadId: target.id, targetThreadId: source.id }),
    ).toEqual({
      kind: "refused",
      reason: "source_is_retire_target",
    });
    expect(retire(fixture, { targetThreadId: other.id })).toEqual({
      kind: "refused",
      reason: "target_retired",
    });
  });

  it("completes a retire at the row maximum inside the time bound (T-E1)", () => {
    const fixture = setup();
    const { db, source, target } = fixture;
    const keys = createOrderKeysAfter({ previousKey: null, count: RETIRE_MAX_SOURCE_QUEUE_ROWS });
    db.transaction(
      (tx) => {
        for (let index = 0; index < RETIRE_MAX_SOURCE_QUEUE_ROWS; index += 1) {
          createQueuedThreadMessageInTransaction(tx, {
            sortKey: keys[index],
            threadId: source.id,
            content: textInput(`m${index}`),
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
      },
      { behavior: "immediate" },
    );
    const started = Date.now();
    const outcome = retire(fixture);
    expect(outcome.kind).toBe("retired");
    expect(Date.now() - started).toBeLessThan(2_500);
    expect(listQueuedThreadMessages(db, target.id)).toHaveLength(RETIRE_MAX_SOURCE_QUEUE_ROWS);
    expect(listQueuedThreadMessages(db, source.id)).toEqual([]);
  }, 60_000);
});

describe("replay and authorization (T-RP1)", () => {
  it("replays the stored result for the same key and hash, even after the source is deleted", () => {
    const fixture = setup();
    const { db, source } = fixture;
    enqueue(db, source.id, "a");
    const first = retire(fixture);
    expect(first.kind).toBe("retired");
    db.$client.prepare("PRAGMA foreign_keys = ON").run();
    expect(deleteThread(db, noopNotifier, source.id)).toBe(true);
    const replay = retire(fixture);
    expect(replay).toMatchObject({ kind: "replayed" });
    if (first.kind !== "retired" || replay.kind !== "replayed") return;
    expect(replay.result).toEqual(first.result);
    expect(replay.operationId).toBe(first.operationId);
  });

  it("returns idempotency_conflict for the same key with a different request", () => {
    const fixture = setup();
    const third = fixture.make();
    expect(retire(fixture).kind).toBe("retired");
    expect(retire(fixture, { targetThreadId: third.id })).toEqual({
      kind: "idempotency_conflict",
    });
  });

  it("does not replay across projects", () => {
    const fixture = setup();
    enqueue(fixture.db, fixture.source.id, "a");
    const first = retire(fixture);
    expect(first.kind).toBe("retired");
    if (first.kind !== "retired") return;
    expect(
      getTransferOperation(fixture.db, first.operationId, {
        projectId: "prj_other",
      }),
    ).toBeNull();
    const crossProject = retire(fixture, { projectId: "prj_other" });
    expect(crossProject).toMatchObject({ kind: "refused" });
  });
});

describe("outbox ledger (T-O1/T-O2 transport not covered)", () => {
  it("appends one event per entry insert and per state change", () => {
    const fixture = setup();
    enqueue(fixture.db, fixture.source.id, "a");
    enqueue(fixture.db, fixture.source.id, "b");
    const outcome = retire(fixture);
    if (outcome.kind !== "retired") throw new Error("expected retired");
    const events = fixture.db.$client
      .prepare(
        "SELECT event_id, state, payload, emitted_at FROM transfer_events ORDER BY event_id",
      )
      .all() as Array<{
      event_id: number;
      state: string;
      payload: string;
      emitted_at: number | null;
    }>;
    expect(events).toHaveLength(2);
    expect(JSON.parse(events[0]?.payload ?? "{}")).toMatchObject({
      kind: "moved",
      state: "terminal",
    });
    fixture.db.$client
      .prepare(
        "UPDATE transfer_entries SET state = 'forwarded' WHERE op_id = ? AND source_row_id = (SELECT source_row_id FROM transfer_entries WHERE op_id = ? LIMIT 1)",
      )
      .run(outcome.operationId, outcome.operationId);
    const after = fixture.db.$client
      .prepare("SELECT COUNT(*) AS n FROM transfer_events")
      .get() as { n: number };
    expect(after.n).toBe(3);
    fixture.db.$client
      .prepare("UPDATE transfer_entries SET detail = 'x' WHERE op_id = ?")
      .run(outcome.operationId);
    expect(
      fixture.db.$client
        .prepare("SELECT COUNT(*) AS n FROM transfer_events")
        .get(),
    ).toEqual({ n: 3 });
  });

  it("makes events immutable apart from a single emitted_at stamp, and allows cascade delete", () => {
    const fixture = setup();
    enqueue(fixture.db, fixture.source.id, "a");
    const outcome = retire(fixture);
    if (outcome.kind !== "retired") throw new Error("expected retired");
    const sql = fixture.db.$client;
    expect(() =>
      sql.prepare("UPDATE transfer_events SET payload = '{}'").run(),
    ).toThrow(/append-only/);
    expect(() =>
      sql.prepare("UPDATE transfer_events SET state = 'x'").run(),
    ).toThrow(/append-only/);
    expect(() =>
      sql.prepare("UPDATE transfer_events SET entry_id = 'x'").run(),
    ).toThrow(/append-only/);
    expect(() =>
      sql.prepare("UPDATE transfer_events SET event_id = 99").run(),
    ).toThrow(/append-only/);
    sql.prepare("UPDATE transfer_events SET emitted_at = 5").run();
    expect(() =>
      sql.prepare("UPDATE transfer_events SET emitted_at = 6").run(),
    ).toThrow(/append-only/);
    expect(() =>
      sql.prepare("UPDATE transfer_events SET emitted_at = NULL").run(),
    ).toThrow(/append-only/);
    sql.prepare("DELETE FROM transfer_events").run();
  });

  it("redelivers unstamped events with the same event_id after a crash and never stamps an unseen event", () => {
    const fixture = setup();
    enqueue(fixture.db, fixture.source.id, "a");
    const outcome = retire(fixture);
    if (outcome.kind !== "retired") throw new Error("expected retired");
    const seen: number[] = [];
    expect(() =>
      drainTransferEvents(fixture.db, () => {
        throw new Error("crash before stamp");
      }),
    ).toThrow(/crash/);
    drainTransferEvents(fixture.db, (events) => {
      seen.push(...events.map((event) => event.eventId));
      fixture.db.$client
        .prepare(
          "UPDATE transfer_entries SET state = 'forwarded' WHERE op_id = ?",
        )
        .run(outcome.operationId);
    });
    expect(seen).toHaveLength(1);
    const unstamped = fixture.db.$client
      .prepare("SELECT event_id FROM transfer_events WHERE emitted_at IS NULL")
      .all() as Array<{ event_id: number }>;
    expect(unstamped).toHaveLength(1);
    expect(unstamped[0]?.event_id).toBeGreaterThan(seen[0] ?? 0);
    const redelivered: number[] = [];
    drainTransferEvents(fixture.db, (events) => {
      redelivered.push(...events.map((event) => event.eventId));
    });
    expect(redelivered).toEqual([unstamped[0]?.event_id]);
  });
});

describe("GET, ack and sweep", () => {
  it("returns current entry states, acks, and sweeps only acked, drained ops", () => {
    const fixture = setup();
    enqueue(fixture.db, fixture.source.id, "a");
    const outcome = retire(fixture);
    if (outcome.kind !== "retired") throw new Error("expected retired");
    const op = getTransferOperation(fixture.db, outcome.operationId);
    expect(op).toMatchObject({ kind: "retire", state: "active" });
    expect(op?.result).toEqual(outcome.result);

    expect(sweepTransferOperations(fixture.db)).toBe(0);
    expect(
      ackTransferOperation(fixture.db, outcome.operationId, fixture.project.id),
    ).toBe(true);
    expect(sweepTransferOperations(fixture.db)).toBe(0);
    drainTransferEvents(fixture.db, () => undefined);
    fixture.db.$client
      .prepare("UPDATE transfer_entries SET state = 'pending'")
      .run();
    expect(sweepTransferOperations(fixture.db)).toBe(0);
    fixture.db.$client
      .prepare("UPDATE transfer_entries SET state = 'terminal'")
      .run();
    drainTransferEvents(fixture.db, () => undefined);
    expect(sweepTransferOperations(fixture.db)).toBe(0);
    fixture.db.$client.prepare("DELETE FROM thread_redirects").run();
    expect(sweepTransferOperations(fixture.db)).toBe(1);
    expect(getTransferOperation(fixture.db, outcome.operationId)).toBeNull();
    expect(
      fixture.db.$client
        .prepare("SELECT COUNT(*) AS n FROM transfer_events")
        .get(),
    ).toEqual({ n: 0 });
    expect(
      ackTransferOperation(fixture.db, outcome.operationId, fixture.project.id),
    ).toBe(false);
  });

  it("refuses to ack across projects", () => {
    const fixture = setup();
    const outcome = retire(fixture);
    if (outcome.kind !== "retired") throw new Error("expected retired");
    expect(
      ackTransferOperation(fixture.db, outcome.operationId, "prj_other"),
    ).toBe(false);
  });
});

describe("triggers", () => {
  it.each([
    ["NULL token", "NULL", false],
    ["ordinary token", "'worker-1'", false],
    ["slot token", "'slot:x'", true],
    ["fill token", "'fill:x'", true],
  ])("guards the slot shape on update with a %s", (_name, token, allowed) => {
    const { db, source } = setup();
    const row = enqueue(db, source.id, "a");
    const run = () =>
      db.$client
        .prepare(
          `UPDATE queued_thread_messages SET forward_source_row_id = 'x', claimed_at = 1, claim_token = ${token} WHERE id = ?`,
        )
        .run(row.id);
    if (allowed) run();
    else expect(run).toThrow(/CHECK constraint failed/);
  });

  it("guards the slot shape on update when unclaimed", () => {
    const { db, source } = setup();
    const row = enqueue(db, source.id, "a");
    expect(() =>
      db.$client
        .prepare(
          "UPDATE queued_thread_messages SET forward_source_row_id = 'x' WHERE id = ?",
        )
        .run(row.id),
    ).toThrow(/CHECK constraint failed/);
  });

  it.each([
    ["NULL token", "NULL", false],
    ["ordinary token", "'worker-1'", false],
    ["slot token", "'slot:x'", true],
    ["fill token", "'fill:x'", true],
  ])("guards the slot shape on insert with a %s", (_name, token, allowed) => {
    const { db, source } = setup();
    const run = () =>
      db.$client
        .prepare(
          `INSERT INTO queued_thread_messages (id, thread_id, content, model, reasoning_level, permission_mode, service_tier, group_with_next, payload_kind, failure_count, sort_key, created_at, updated_at, forward_source_row_id, claimed_at, claim_token)
           VALUES ('qmsg_slot', ?, '[]', 'm', 'r', 'full', 'default', 0, 'inline', 0, 'a0', 1, 1, 'x', 1, ${token})`,
        )
        .run(source.id);
    if (allowed) run();
    else expect(run).toThrow(/CHECK constraint failed/);
  });

  it("tombstones inbound redirects and removes the outbound one on soft delete, and rewires on hard delete", () => {
    const fixture = setup();
    const { db, source, target, make } = fixture;
    const mid = make();
    db.$client
      .prepare(
        "INSERT INTO transfer_operations (id, project_id, operation_key, request_hash, kind, source_thread_id, target_thread_id, state, created_at) VALUES ('op_a', ?, 'ka', 'h', 'retire', ?, ?, 'active', 1), ('op_b', ?, 'kb', 'h', 'retire', ?, ?, 'active', 1)",
      )
      .run(
        fixture.project.id,
        source.id,
        mid.id,
        fixture.project.id,
        mid.id,
        target.id,
      );
    db.$client
      .prepare(
        "INSERT INTO thread_redirects VALUES (?, ?, 'op_a'), (?, ?, 'op_b')",
      )
      .run(source.id, mid.id, mid.id, target.id);
    db.$client
      .prepare("UPDATE threads SET deleted_at = 5 WHERE id = ?")
      .run(mid.id);
    expect(
      db.$client
        .prepare(
          "SELECT source_thread_id, successor_thread_id FROM thread_redirects",
        )
        .all(),
    ).toEqual([{ source_thread_id: source.id, successor_thread_id: null }]);

    db.$client
      .prepare(
        "UPDATE thread_redirects SET successor_thread_id = ? WHERE source_thread_id = ?",
      )
      .run(target.id, source.id);
    expect(deleteThread(db, noopNotifier, target.id)).toBe(true);
    expect(
      db.$client
        .prepare(
          "SELECT source_thread_id, successor_thread_id FROM thread_redirects",
        )
        .all(),
    ).toEqual([{ source_thread_id: source.id, successor_thread_id: null }]);
  });
});
