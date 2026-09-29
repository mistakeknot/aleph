import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import type { PromptInput, RelayProvenance } from "@bb/domain";
import { noopNotifier } from "../../src/notifier.js";
import { upsertHost } from "../../src/data/hosts.js";
import { createProject } from "../../src/data/projects.js";
import { createThread } from "../../src/data/threads.js";
import {
  claimNextQueuedThreadMessageGroup,
  claimQueuedThreadMessage,
  claimQueuedThreadMessageGroup,
  createQueuedThreadMessage,
  getQueuedThreadMessage,
  listQueuedThreadMessages,
  setQueuedThreadMessageGroupBoundary,
} from "../../src/data/queued-thread-messages.js";
import {
  RELAY_CLEANUP_CLAIM_MS,
  cancelRelayForHostInTransaction,
  cancelRelayForHostTargetsInTransaction,
  cancelRelayForTargetInTransaction,
  claimRelayAttemptCleanupInTransaction,
  claimUnownedRelayAttachmentsForDeletionInTransaction,
  completeRelayAttemptCleanupInTransaction,
  getRelayMessage,
  insertRelayTarget,
  takeOverRelayAttemptCleanupInTransaction,
} from "../../src/data/relay.js";
import { recordProjectAttachment } from "../../src/data/project-attachments.js";
import { projectAttachments, relayMessages } from "../../src/schema.js";
import { createMigratedConnection } from "../helpers/migrated-connection.js";

function textInput(text: string): PromptInput[] {
  return [{ type: "text", text, mentions: [] }];
}

function setup() {
  const db = createMigratedConnection();
  const host = upsertHost(db, noopNotifier, { name: "relay-host" });
  const { project } = createProject(db, noopNotifier, {
    name: "relay-project",
    source: { type: "local_path", hostId: host.id, path: "/tmp/relay" },
  });
  const thread = createThread(db, noopNotifier, {
    projectId: project.id,
    providerId: "codex",
  });
  insertRelayTarget(db, {
    hostId: host.id,
    threadId: thread.id,
    createdByUserId: "user-1",
  });
  return { db, host, project, thread };
}

type Db = ReturnType<typeof setup>["db"];

function provenance(
  hostId: string,
  relayMessageId: string,
): RelayProvenance {
  return {
    relayMessageId,
    hostId,
    hostName: "relay-host",
    clientMessageId: `client-${relayMessageId}`,
    label: null,
  };
}

function queueRow(
  db: Db,
  threadId: string,
  text: string,
  relayProvenance: RelayProvenance | null,
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
    relayProvenance,
  });
}

function insertRelayMessage(
  db: Db,
  args: {
    id: string;
    hostId: string;
    threadId: string;
    status: "reserved" | "accepted" | "cleaning" | "failed" | "cancelled";
    queuedMessageId?: string | null;
    leaseToken?: string | null;
    leaseExpiresAt?: number | null;
    cleanupToken?: string | null;
    cleanupExpiresAt?: number | null;
  },
) {
  db.insert(relayMessages)
    .values({
      id: args.id,
      hostId: args.hostId,
      clientMessageId: `client-${args.id}`,
      clientMessageTime: 1,
      threadId: args.threadId,
      payloadSha256: "abc",
      status: args.status,
      attempt: 1,
      leaseToken:
        args.leaseToken === undefined
          ? args.status === "reserved"
            ? "lease-1"
            : null
          : args.leaseToken,
      leaseExpiresAt:
        args.leaseExpiresAt === undefined
          ? args.status === "reserved"
            ? 10_000
            : null
          : args.leaseExpiresAt,
      cleanupToken: args.cleanupToken ?? null,
      cleanupExpiresAt: args.cleanupExpiresAt ?? null,
      queuedMessageId: args.queuedMessageId ?? null,
      createdAt: 1,
      updatedAt: 1,
    })
    .run();
}

describe("relay_messages claim-invariant CHECK constraints (T-DB-1)", () => {
  it("rejects a cleaning row without cleanup columns", () => {
    const { db, host, thread } = setup();
    expect(() =>
      insertRelayMessage(db, {
        id: "rm1",
        hostId: host.id,
        threadId: thread.id,
        status: "cleaning",
      }),
    ).toThrow();
  });

  it("rejects cleanup columns on a non-cleaning row", () => {
    const { db, host, thread } = setup();
    expect(() =>
      insertRelayMessage(db, {
        id: "rm1",
        hostId: host.id,
        threadId: thread.id,
        status: "accepted",
        cleanupToken: "t",
        cleanupExpiresAt: 5,
      }),
    ).toThrow();
  });

  it("rejects a reserved row without a lease and a leased non-reserved row", () => {
    const { db, host, thread } = setup();
    expect(() =>
      insertRelayMessage(db, {
        id: "rm1",
        hostId: host.id,
        threadId: thread.id,
        status: "reserved",
        leaseToken: null,
        leaseExpiresAt: null,
      }),
    ).toThrow();
    expect(() =>
      insertRelayMessage(db, {
        id: "rm2",
        hostId: host.id,
        threadId: thread.id,
        status: "accepted",
        leaseToken: "l",
        leaseExpiresAt: 5,
      }),
    ).toThrow();
  });

  it("rejects a half-set cleanup claim", () => {
    const { db, host, thread } = setup();
    expect(() =>
      insertRelayMessage(db, {
        id: "rm1",
        hostId: host.id,
        threadId: thread.id,
        status: "cleaning",
        cleanupToken: "t",
        cleanupExpiresAt: null,
      }),
    ).toThrow();
  });

  it("rejects an unknown relay_messages status", () => {
    const { db, host, thread } = setup();
    let cause: unknown;
    try {
      db.run(
        sql`INSERT INTO relay_messages (id, host_id, client_message_id, client_message_time, thread_id, payload_sha256, status, attempt, created_at, updated_at) VALUES ('x', ${host.id}, 'c', 1, ${thread.id}, 'h', 'unknown', 1, 1, 1)`,
      );
    } catch (error) {
      cause = (error as Error).cause;
    }
    expect((cause as Error).message).toMatch(/CHECK constraint failed/);
  });

  it("rejects attempt 0, negative usage and an unknown binding runtime", () => {
    const { db, host, thread } = setup();
    expect(() =>
      db.run(
        sql`INSERT INTO relay_messages (id, host_id, client_message_id, client_message_time, thread_id, payload_sha256, status, attempt, created_at, updated_at) VALUES ('x', ${host.id}, 'c', 1, ${thread.id}, 'h', 'accepted', 0, 1, 1)`,
      ),
    ).toThrow();
    expect(() =>
      db.run(
        sql`INSERT INTO relay_usage (host_id, hour_bucket, reservations, attachment_bytes) VALUES (${host.id}, 1, -1, 0)`,
      ),
    ).toThrow();
    expect(() =>
      db.run(
        sql`INSERT INTO connect_binding (id, runtime, issuer, server_id, owner_user_id, bound_at) VALUES (1, 'dev', 'i', 's', 'u', 1)`,
      ),
    ).toThrow();
  });

  it("rejects a second connect_binding row", () => {
    const { db } = setup();
    db.run(
      sql`INSERT INTO connect_binding (id, runtime, issuer, server_id, owner_user_id, bound_at) VALUES (1, 'production', 'i', 's', 'u', 1)`,
    );
    expect(() =>
      db.run(
        sql`INSERT INTO connect_binding (id, runtime, issuer, server_id, owner_user_id, bound_at) VALUES (2, 'staging', 'i', 's', 'u', 1)`,
      ),
    ).toThrow();
  });

  it("only the shared claim and takeover functions write cleaning state", () => {
    const srcRoot = join(__dirname, "..", "..", "src");
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (full.endsWith(".ts")) files.push(full);
      }
    };
    walk(srcRoot);
    const offenders = files.filter((file) => {
      if (file.endsWith(join("data", "relay.ts"))) return false;
      if (file.endsWith("schema.ts")) return false;
      const text = readFileSync(file, "utf8");
      return /status:\s*"cleaning"|cleanupExpiresAt\s*:/.test(text);
    });
    expect(offenders).toEqual([]);
    const relaySource = readFileSync(join(srcRoot, "data", "relay.ts"), "utf8");
    expect(relaySource.match(/status:\s*"cleaning"/g)).toHaveLength(1);
    expect(relaySource.match(/cleanupExpiresAt:\s*now/g)).toHaveLength(2);
  });
});

describe("relay cleanup claim, takeover and completion", () => {
  it("moves reserved to cleaning, clearing the lease", () => {
    const { db, host, thread } = setup();
    insertRelayMessage(db, {
      id: "rm1",
      hostId: host.id,
      threadId: thread.id,
      status: "reserved",
    });
    const row = getRelayMessage(db, "rm1")!;
    const claimed = db.transaction((tx) =>
      claimRelayAttemptCleanupInTransaction(tx, row, { now: 1_000 }),
    );
    expect(claimed).toMatchObject({
      status: "cleaning",
      leaseToken: null,
      leaseExpiresAt: null,
      cleanupExpiresAt: 1_000 + RELAY_CLEANUP_CLAIM_MS,
      cancelReason: null,
    });
    expect(claimed?.cleanupToken).toBe("lease-1");
    expect(
      db.transaction((tx) => claimRelayAttemptCleanupInTransaction(tx, row)),
    ).toBeNull();
  });

  it("takes over only an expired claim and keeps the attempt token", () => {
    const { db, host, thread } = setup();
    insertRelayMessage(db, {
      id: "rm1",
      hostId: host.id,
      threadId: thread.id,
      status: "reserved",
      leaseToken: "attempt-7",
    });
    const claimed = db.transaction((tx) =>
      claimRelayAttemptCleanupInTransaction(tx, getRelayMessage(db, "rm1")!, {
        now: 1_000,
      }),
    )!;
    expect(claimed.cleanupToken).toBe("attempt-7");
    expect(
      db.transaction((tx) =>
        takeOverRelayAttemptCleanupInTransaction(tx, claimed, { now: 1_001 }),
      ),
    ).toBeNull();
    const taken = db.transaction((tx) =>
      takeOverRelayAttemptCleanupInTransaction(tx, claimed, {
        now: 1_000 + RELAY_CLEANUP_CLAIM_MS,
      }),
    );
    expect(taken?.status).toBe("cleaning");
    expect(taken?.cleanupToken).toBe("attempt-7");
    expect(taken?.cleanupExpiresAt).toBe(1_000 + 2 * RELAY_CLEANUP_CLAIM_MS);
    expect(
      db.transaction((tx) =>
        takeOverRelayAttemptCleanupInTransaction(tx, claimed, {
          now: 1_000 + RELAY_CLEANUP_CLAIM_MS,
        }),
      ),
    ).toBeNull();
  });

  it("finds and cleans the attempt's attachment rows after takeover", () => {
    const { db, host, thread, project } = setup();
    insertRelayMessage(db, {
      id: "rm1",
      hostId: host.id,
      threadId: thread.id,
      status: "reserved",
      leaseToken: "attempt-1",
    });
    const mine = recordProjectAttachment(db, {
      projectId: project.id,
      storedPath: "relay/mine.txt",
      originalName: "mine.txt",
      mimeType: null,
      sizeBytes: 1,
      createdAt: 1,
      readyAt: null,
      relayMessageId: "rm1",
      relayAttemptToken: "attempt-1",
    });
    const other = recordProjectAttachment(db, {
      projectId: project.id,
      storedPath: "relay/other.txt",
      originalName: "other.txt",
      mimeType: null,
      sizeBytes: 1,
      createdAt: 1,
      readyAt: null,
      relayMessageId: "rm1",
      relayAttemptToken: "attempt-2",
    });
    const claimed = db.transaction((tx) =>
      claimRelayAttemptCleanupInTransaction(tx, getRelayMessage(db, "rm1")!, {
        now: 1_000,
      }),
    )!;
    const taken = db.transaction((tx) =>
      takeOverRelayAttemptCleanupInTransaction(tx, claimed, {
        now: 1_000 + RELAY_CLEANUP_CLAIM_MS,
      }),
    )!;
    const count = db.transaction((tx) =>
      claimUnownedRelayAttachmentsForDeletionInTransaction(tx, {
        relayMessageId: taken.id,
        relayAttemptToken: taken.cleanupToken!,
      }),
    );
    expect(count).toBe(1);
    const claimedAt = (id: string) =>
      db
        .select()
        .from(projectAttachments)
        .where(eq(projectAttachments.id, id))
        .get()?.deletionClaimedAt;
    expect(claimedAt(mine.id)).not.toBeNull();
    expect(claimedAt(other.id)).toBeNull();
    expect(
      db.transaction((tx) =>
        completeRelayAttemptCleanupInTransaction(tx, {
          id: taken.id,
          cleanupToken: taken.cleanupToken!,
        }),
      )?.status,
    ).toBe("failed");
  });

  it("completes to failed, or to cancelled when a cancel reason is set", () => {
    const { db, host, thread } = setup();
    insertRelayMessage(db, {
      id: "rm1",
      hostId: host.id,
      threadId: thread.id,
      status: "reserved",
      leaseToken: "l1",
    });
    insertRelayMessage(db, {
      id: "rm2",
      hostId: host.id,
      threadId: thread.id,
      status: "reserved",
      leaseToken: "l2",
    });
    const c1 = db.transaction((tx) =>
      claimRelayAttemptCleanupInTransaction(tx, getRelayMessage(db, "rm1")!),
    )!;
    const c2 = db.transaction((tx) =>
      claimRelayAttemptCleanupInTransaction(tx, getRelayMessage(db, "rm2")!, {
        cancelReason: "host_revoked",
      }),
    )!;
    expect(
      db.transaction((tx) =>
        completeRelayAttemptCleanupInTransaction(tx, {
          id: c1.id,
          cleanupToken: "wrong",
        }),
      ),
    ).toBeNull();
    expect(
      db.transaction((tx) =>
        completeRelayAttemptCleanupInTransaction(tx, {
          id: c1.id,
          cleanupToken: c1.cleanupToken!,
        }),
      ),
    ).toMatchObject({
      status: "failed",
      cleanupToken: null,
      cleanupExpiresAt: null,
    });
    expect(
      db.transaction((tx) =>
        completeRelayAttemptCleanupInTransaction(tx, {
          id: c2.id,
          cleanupToken: c2.cleanupToken!,
        }),
      ),
    ).toMatchObject({ status: "cancelled", cancelReason: "host_revoked" });
  });
});

describe("relay cancellation functions", () => {
  function seed() {
    const ctx = setup();
    const { db, host, project, thread } = ctx;
    const queued = queueRow(db, thread.id, "relay", provenance(host.id, "rm-q"));
    insertRelayMessage(db, {
      id: "rm-q",
      hostId: host.id,
      threadId: thread.id,
      status: "accepted",
      queuedMessageId: queued.id,
    });
    insertRelayMessage(db, {
      id: "rm-r",
      hostId: host.id,
      threadId: thread.id,
      status: "reserved",
      leaseToken: "attempt-1",
    });
    const orphan = recordProjectAttachment(db, {
      projectId: project.id,
      storedPath: "relay/a.txt",
      originalName: "a.txt",
      mimeType: null,
      sizeBytes: 3,
      createdAt: 1,
      readyAt: null,
      relayMessageId: "rm-r",
      relayAttemptToken: "attempt-1",
    });
    return { ...ctx, queued, orphan };
  }

  it.each([
    ["host", (tx: Parameters<typeof cancelRelayForHostInTransaction>[0], h: string) =>
      cancelRelayForHostInTransaction(tx, h, "why")],
    ["host targets", (tx: Parameters<typeof cancelRelayForHostInTransaction>[0], h: string) =>
      cancelRelayForHostTargetsInTransaction(tx, h, "why")],
  ])("cancels everything for the %s scope", (_name, run) => {
    const { db, host, thread, queued, orphan } = seed();
    const result = db.transaction((tx) => run(tx, host.id), {
      behavior: "immediate",
    });
    expect(result).toMatchObject({
      removedTargets: 1,
      cancelledQueuedMessages: 1,
      claimedAttempts: 1,
    });
    expect(result.affectedThreadIds).toEqual([thread.id]);
    expect(getQueuedThreadMessage(db, queued.id)).toBeNull();
    expect(getRelayMessage(db, "rm-q")).toMatchObject({
      status: "cancelled",
      cancelReason: "why",
    });
    expect(getRelayMessage(db, "rm-r")).toMatchObject({
      status: "cleaning",
      cancelReason: "why",
      leaseToken: null,
    });
    expect(
      db
        .select()
        .from(projectAttachments)
        .where(eq(projectAttachments.id, orphan.id))
        .get()?.deletionClaimedAt,
    ).not.toBeNull();
  });

  it("the target scope leaves other threads and hosts alone", () => {
    const { db, host, project, thread } = seed();
    const other = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
    });
    insertRelayTarget(db, {
      hostId: host.id,
      threadId: other.id,
      createdByUserId: "user-1",
    });
    const otherQueued = queueRow(
      db,
      other.id,
      "keep",
      provenance(host.id, "rm-other"),
    );
    const result = db.transaction(
      (tx) => cancelRelayForTargetInTransaction(tx, host.id, thread.id, "gone"),
      { behavior: "immediate" },
    );
    expect(result.removedTargets).toBe(1);
    expect(getQueuedThreadMessage(db, otherQueued.id)).not.toBeNull();
  });

  it("records the reason on a row already cleaning without changing its claim", () => {
    const { db, host, thread } = setup();
    insertRelayMessage(db, {
      id: "rm1",
      hostId: host.id,
      threadId: thread.id,
      status: "cleaning",
      cleanupToken: "tok",
      cleanupExpiresAt: 99,
    });
    db.transaction(
      (tx) => cancelRelayForHostInTransaction(tx, host.id, "later"),
      { behavior: "immediate" },
    );
    expect(getRelayMessage(db, "rm1")).toMatchObject({
      status: "cleaning",
      cleanupToken: "tok",
      cleanupExpiresAt: 99,
      cancelReason: "later",
    });
  });

  it("does not claim attachments already owned by a thread or claimed", () => {
    const { db, host, thread, project } = setup();
    insertRelayMessage(db, {
      id: "rm1",
      hostId: host.id,
      threadId: thread.id,
      status: "reserved",
      leaseToken: "a1",
    });
    const owned = recordProjectAttachment(db, {
      projectId: project.id,
      storedPath: "relay/owned.txt",
      originalName: "owned.txt",
      mimeType: null,
      sizeBytes: 1,
      createdAt: 1,
      readyAt: null,
      relayMessageId: "rm1",
      relayAttemptToken: "a1",
    });
    db.run(
      sql`INSERT INTO project_attachment_threads (attachment_id, thread_id) VALUES (${owned.id}, ${thread.id})`,
    );
    db.transaction(
      (tx) => cancelRelayForHostInTransaction(tx, host.id, "x"),
      { behavior: "immediate" },
    );
    expect(
      db
        .select()
        .from(projectAttachments)
        .where(eq(projectAttachments.id, owned.id))
        .get()?.deletionClaimedAt,
    ).toBeNull();
  });
});

describe("relay claim re-authorization (T-REV-4 db half)", () => {
  function seedQueued() {
    const ctx = setup();
    const queued = queueRow(
      ctx.db,
      ctx.thread.id,
      "relay",
      provenance(ctx.host.id, "rm-q"),
    );
    insertRelayMessage(ctx.db, {
      id: "rm-q",
      hostId: ctx.host.id,
      threadId: ctx.thread.id,
      status: "accepted",
      queuedMessageId: queued.id,
    });
    return { ...ctx, queued };
  }

  function revokeTarget(ctx: ReturnType<typeof seedQueued>) {
    ctx.db.run(sql`DELETE FROM relay_targets`);
  }

  it("claims normally while the target exists", () => {
    const { db, queued } = seedQueued();
    expect(
      claimQueuedThreadMessage(db, noopNotifier, queued.id)?.id,
    ).toBe(queued.id);
  });

  it("explicit send-now cancels the row when the target row is gone", () => {
    const ctx = seedQueued();
    revokeTarget(ctx);
    const claimed = claimQueuedThreadMessageGroup(
      ctx.db,
      noopNotifier,
      ctx.queued.id,
      { kind: "explicit-send" },
    );
    expect(claimed).toBeNull();
    expect(getQueuedThreadMessage(ctx.db, ctx.queued.id)).toBeNull();
    expect(getRelayMessage(ctx.db, "rm-q")).toMatchObject({
      status: "cancelled",
      cancelReason: "revoked_at_claim",
    });
  });

  it("idle drain cancels the row when the target row is gone", () => {
    const ctx = seedQueued();
    revokeTarget(ctx);
    expect(
      claimNextQueuedThreadMessageGroup(ctx.db, noopNotifier, ctx.thread.id),
    ).toBeNull();
    expect(getQueuedThreadMessage(ctx.db, ctx.queued.id)).toBeNull();
    expect(getRelayMessage(ctx.db, "rm-q")?.status).toBe("cancelled");
  });

  it("single-row claim cancels the row when the host is destroyed", () => {
    const ctx = seedQueued();
    upsertHost(ctx.db, noopNotifier, {
      id: ctx.host.id,
      name: ctx.host.name,
      destroyedAt: Date.now(),
    });
    expect(
      claimQueuedThreadMessage(ctx.db, noopNotifier, ctx.queued.id),
    ).toBeNull();
    expect(getRelayMessage(ctx.db, "rm-q")?.status).toBe("cancelled");
  });

  it("does not disturb ordinary rows behind a revoked one", () => {
    const ctx = seedQueued();
    const user = queueRow(ctx.db, ctx.thread.id, "user", null);
    revokeTarget(ctx);
    const claimed = claimNextQueuedThreadMessageGroup(
      ctx.db,
      noopNotifier,
      ctx.thread.id,
    );
    expect(claimed?.map((row) => row.id)).toEqual([user.id]);
  });
});

describe("relay grouping envelope (T-PRV-3)", () => {
  it("never groups a relay row with a user row", () => {
    const { db, host, thread } = setup();
    const user = queueRow(db, thread.id, "user", null);
    const relay = queueRow(db, thread.id, "relay", provenance(host.id, "r1"));
    const boundary = setQueuedThreadMessageGroupBoundary({
      db,
      expectedGroupedPrefixQueuedMessageIds: [user.id, relay.id],
      groupBoundaryQueuedMessageId: relay.id,
      notifier: noopNotifier,
      threadId: thread.id,
    });
    expect(boundary.kind).toBe("invalid_execution_options");
    expect(listQueuedThreadMessages(db, thread.id).map((r) => r.groupWithNext)).toEqual([
      false,
      false,
    ]);
  });

  it("keeps a relay row and a user row with groupWithNext in separate claims", () => {
    const { db, host, thread } = setup();
    const user = queueRow(db, thread.id, "user", null);
    const relay = queueRow(db, thread.id, "relay", provenance(host.id, "r1"));
    db.run(
      sql`UPDATE queued_thread_messages SET group_with_next = 1 WHERE id = ${user.id}`,
    );
    const first = claimNextQueuedThreadMessageGroup(
      db,
      noopNotifier,
      thread.id,
    );
    expect(first?.map((row) => row.id)).toEqual([user.id]);
    const second = claimNextQueuedThreadMessageGroup(
      db,
      noopNotifier,
      thread.id,
    );
    expect(second?.map((row) => row.id)).toEqual([relay.id]);
  });

  it("never groups two relay rows", () => {
    const { db, host, thread } = setup();
    const a = queueRow(db, thread.id, "a", provenance(host.id, "r1"));
    const b = queueRow(db, thread.id, "b", provenance(host.id, "r2"));
    const boundary = setQueuedThreadMessageGroupBoundary({
      db,
      expectedGroupedPrefixQueuedMessageIds: [a.id, b.id],
      groupBoundaryQueuedMessageId: b.id,
      notifier: noopNotifier,
      threadId: thread.id,
    });
    expect(boundary.kind).toBe("invalid_execution_options");
  });
});
