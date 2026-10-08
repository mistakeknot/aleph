import { describe, expect, it } from "vitest";
import type { PromptInput } from "@bb/domain";
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
  getQueuedThreadMessage,
  releaseQueuedMessageClaim,
} from "../../src/data/queued-thread-messages.js";
import {
  getTransferOperation,
  retireQueuedThreadMessages,
} from "../../src/data/transfer-operations.js";
import { queuedThreadMessages } from "../../src/schema.js";
import { asc, eq } from "drizzle-orm";
import { createMigratedConnection } from "../helpers/migrated-connection.js";

function textInput(text: string): PromptInput[] {
  return [{ type: "text", text, mentions: [] }];
}

export function setup() {
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

export type Fixture = ReturnType<typeof setup>;

export function enqueue(
  db: Fixture["db"],
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

export const resolveWaitingOn = () => ({ kind: "thread-busy" }) as const;

export function retire(
  fixture: Fixture,
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

export function claim(fixture: Fixture, id: string) {
  const claimed = claimQueuedThreadMessage(fixture.db, noopNotifier, id);
  if (!claimed) throw new Error(`claim of ${id} failed`);
  return claimed;
}

export function release(fixture: Fixture, id: string, token: string) {
  return releaseQueuedMessageClaim(fixture.db, noopNotifier, {
    id,
    claimToken: token,
  });
}

export function entries(fixture: Fixture, operationId: string) {
  return getTransferOperation(fixture.db, operationId)?.entries ?? [];
}

export function allRows(fixture: Fixture, threadId: string) {
  return fixture.db
    .select()
    .from(queuedThreadMessages)
    .where(eq(queuedThreadMessages.threadId, threadId))
    .orderBy(asc(queuedThreadMessages.sortKey), asc(queuedThreadMessages.id))
    .all();
}

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
});
