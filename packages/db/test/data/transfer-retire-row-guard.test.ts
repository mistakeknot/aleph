import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createConnection } from "../../src/connection.js";
import type { DbTransaction } from "../../src/connection.js";
import { migrate } from "../../src/migrate.js";
import { noopNotifier } from "../../src/notifier.js";
import { upsertHost } from "../../src/data/hosts.js";
import { createProject } from "../../src/data/projects.js";
import { createThread } from "../../src/data/threads.js";
import { queuedThreadMessages } from "../../src/schema.js";
import {
  RETIRE_MAX_SOURCE_QUEUE_ROWS,
  retireQueuedThreadMessages,
} from "../../src/data/transfer-operations.js";
import { withWriteAfterFirstRead } from "../helpers/interleave.js";
import {
  enqueue,
  resolveWaitingOn,
  setup as setupInMemory,
} from "../helpers/retire-fixture.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function setupFile() {
  const directory = mkdtempSync(join(tmpdir(), "retire-guard-"));
  directories.push(directory);
  const path = join(directory, "guard.db");
  const db = createConnection(path);
  migrate(db);
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
  return { db, path, project, source: make(), target: make() };
}

function bulkInsert(
  db: ReturnType<typeof createConnection>,
  threadId: string,
  count: number,
  prefix: string,
) {
  db.$client
    .prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<${count}) INSERT INTO queued_thread_messages (id,origin_id,thread_id,content,model,reasoning_level,permission_mode,service_tier,group_with_next,payload_kind,sort_key,created_at,updated_at) SELECT '${prefix}'||i,'${prefix}'||i,?,'[{"type":"text","text":"x","mentions":[]}]','m','r','full','default',0,'inline',printf('k%08d',i),1,1 FROM n`,
    )
    .run(threadId);
}

function snapshot(db: ReturnType<typeof createConnection>) {
  const dump = (table: string) =>
    db.$client.prepare(`SELECT * FROM ${table} ORDER BY 1, 2`).all();
  return {
    queued: dump("queued_thread_messages"),
    operations: dump("transfer_operations"),
    entries: dump("transfer_entries"),
    events: dump("transfer_events"),
    redirects: dump("thread_redirects"),
  };
}

function retireFile(
  fixture: ReturnType<typeof setupFile>,
  db: ReturnType<typeof createConnection> = fixture.db,
) {
  return retireQueuedThreadMessages(db, {
    projectId: fixture.project.id,
    sourceThreadId: fixture.source.id,
    targetThreadId: fixture.target.id,
    operationKey: "key-1",
    retireEnabled: true,
    resolveWaitingOn,
  });
}

describe("retire source row-count guard", () => {
  it("retires a source holding exactly the maximum number of rows", () => {
    const fixture = setupFile();
    bulkInsert(
      fixture.db,
      fixture.source.id,
      RETIRE_MAX_SOURCE_QUEUE_ROWS,
      "row",
    );
    const outcome = retireFile(fixture);
    if (outcome.kind !== "retired") throw new Error(outcome.kind);
    expect(outcome.result.moved).toHaveLength(RETIRE_MAX_SOURCE_QUEUE_ROWS);
    expect(
      fixture.db.$client
        .prepare("SELECT COUNT(*) AS n FROM queued_thread_messages WHERE thread_id = ?")
        .get(fixture.target.id),
    ).toEqual({ n: RETIRE_MAX_SOURCE_QUEUE_ROWS });
  });

  it("refuses one row over the maximum and changes nothing", () => {
    const fixture = setupFile();
    bulkInsert(
      fixture.db,
      fixture.source.id,
      RETIRE_MAX_SOURCE_QUEUE_ROWS + 1,
      "row",
    );
    const before = snapshot(fixture.db);
    expect(retireFile(fixture)).toEqual({
      kind: "refused",
      reason: "source_queue_too_large",
    });
    expect(snapshot(fixture.db)).toEqual(before);
    expect(before.operations).toEqual([]);
    expect(before.redirects).toEqual([]);
  });

  it("does not burn the operation key, so the retry succeeds once the queue shrinks", () => {
    const fixture = setupFile();
    bulkInsert(
      fixture.db,
      fixture.source.id,
      RETIRE_MAX_SOURCE_QUEUE_ROWS + 1,
      "row",
    );
    expect(retireFile(fixture)).toMatchObject({
      kind: "refused",
      reason: "source_queue_too_large",
    });
    fixture.db.$client
      .prepare("DELETE FROM queued_thread_messages WHERE id = 'row1'")
      .run();
    expect(retireFile(fixture).kind).toBe("retired");
  });

  it("counts every row on the source, including rows that cannot be forwarded", () => {
    const fixture = setupFile();
    bulkInsert(
      fixture.db,
      fixture.source.id,
      RETIRE_MAX_SOURCE_QUEUE_ROWS,
      "row",
    );
    fixture.db.$client
      .prepare("UPDATE queued_thread_messages SET payload_kind = 'command'")
      .run();
    bulkInsert(fixture.db, fixture.source.id, 1, "extra");
    expect(retireFile(fixture)).toEqual({
      kind: "refused",
      reason: "source_queue_too_large",
    });
  });

  it("counts only the source thread, not the rows already on the target", () => {
    const fixture = setupFile();
    bulkInsert(
      fixture.db,
      fixture.target.id,
      RETIRE_MAX_SOURCE_QUEUE_ROWS + 5,
      "tgt",
    );
    bulkInsert(fixture.db, fixture.source.id, 3, "src");
    expect(retireFile(fixture).kind).toBe("retired");
  });

  it("returns the replayed result for a repeated key even after the queue grows past the maximum", () => {
    const fixture = setupFile();
    bulkInsert(fixture.db, fixture.source.id, 2, "row");
    const first = retireFile(fixture);
    if (first.kind !== "retired") throw new Error(first.kind);
    bulkInsert(
      fixture.db,
      fixture.source.id,
      RETIRE_MAX_SOURCE_QUEUE_ROWS + 1,
      "late",
    );
    const replay = retireFile(fixture);
    expect(replay).toMatchObject({
      kind: "replayed",
      operationId: first.operationId,
    });
  });

  it("is decided inside the retire transaction: a row committed by another connection before it starts is counted", () => {
    const fixture = setupFile();
    bulkInsert(
      fixture.db,
      fixture.source.id,
      RETIRE_MAX_SOURCE_QUEUE_ROWS,
      "row",
    );
    const other = new Database(fixture.path);
    try {
      other.pragma("busy_timeout = 0");
      other
        .prepare(
          "INSERT INTO queued_thread_messages (id,origin_id,thread_id,content,model,reasoning_level,permission_mode,service_tier,group_with_next,payload_kind,sort_key,created_at,updated_at) VALUES ('late','late',?,'[]','m','r','full','default',0,'inline','z',1,1)",
        )
        .run(fixture.source.id);
    } finally {
      other.close();
    }
    const before = snapshot(fixture.db);
    expect(retireFile(fixture)).toEqual({
      kind: "refused",
      reason: "source_queue_too_large",
    });
    expect(snapshot(fixture.db)).toEqual(before);
  });

  it("cannot be raced: the count sees rows written after the transaction began, and a second connection is locked out", () => {
    const fixture = setupFile();
    bulkInsert(
      fixture.db,
      fixture.source.id,
      RETIRE_MAX_SOURCE_QUEUE_ROWS,
      "row",
    );
    const other = new Database(fixture.path);
    other.pragma("busy_timeout = 0");
    let blocked: unknown = null;
    const raced = new Proxy(fixture.db, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (property !== "transaction") return value;
        return (run: (tx: DbTransaction) => unknown, options: object) =>
          target.transaction(
            (tx: DbTransaction) =>
              run(
                withWriteAfterFirstRead(tx, () => {
                  try {
                    other
                      .prepare(
                        "INSERT INTO queued_thread_messages (id,origin_id,thread_id,content,model,reasoning_level,permission_mode,service_tier,group_with_next,payload_kind,sort_key,created_at,updated_at) VALUES ('late','late',?,'[]','m','r','full','default',0,'inline','z',1,1)",
                      )
                      .run(fixture.source.id);
                  } catch (error) {
                    blocked = error;
                  }
                  tx.insert(queuedThreadMessages)
                    .values({
                      id: "inside",
                      originId: "inside",
                      threadId: fixture.source.id,
                      content: "[]",
                      model: "m",
                      reasoningLevel: "r",
                      permissionMode: "full",
                      serviceTier: "default",
                      groupWithNext: false,
                      payloadKind: "inline",
                      sortKey: "y",
                      createdAt: 1,
                      updatedAt: 1,
                    })
                    .run();
                }),
              ),
            options,
          );
      },
    });
    try {
      expect(retireFile(fixture, raced)).toEqual({
        kind: "refused",
        reason: "source_queue_too_large",
      });
    } finally {
      other.close();
    }
    expect(String((blocked as Error | null)?.message)).toMatch(/locked|busy/i);
    expect(
      fixture.db.$client
        .prepare("SELECT COUNT(*) AS n FROM queued_thread_messages WHERE id = 'late'")
        .get(),
    ).toEqual({ n: 0 });
    expect(
      fixture.db.$client
        .prepare("SELECT COUNT(*) AS n FROM thread_redirects")
        .get(),
    ).toEqual({ n: 0 });
  });

  it("leaves the small-queue path unchanged", () => {
    const fixture = setupInMemory();
    enqueue(fixture.db, fixture.source.id, "a");
    enqueue(fixture.db, fixture.source.id, "b");
    const outcome = retireQueuedThreadMessages(fixture.db, {
      projectId: fixture.project.id,
      sourceThreadId: fixture.source.id,
      targetThreadId: fixture.target.id,
      operationKey: "key-1",
      retireEnabled: true,
      resolveWaitingOn,
    });
    expect(outcome.kind).toBe("retired");
  });
});
