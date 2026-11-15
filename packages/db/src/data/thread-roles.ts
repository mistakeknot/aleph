import { and, asc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import {
  threadRoleMaxGeneration,
  threadRoleNameSchema,
  type ThreadRoleUpdatedByKind,
} from "@bb/domain";
import { rootConnectionOf } from "../connection.js";
import type { DbConnection, DbQueryConnection } from "../connection.js";
import { threadRoles, threads } from "../schema.js";

type ThreadRoleConnection = DbConnection | DbQueryConnection;

export type ThreadRoleErrorCode =
  | "invalid_role_name"
  | "role_not_found"
  | "role_not_held"
  | "role_held"
  | "role_generation_conflict"
  | "role_generation_exhausted"
  | "thread_not_found"
  | "thread_deleted"
  | "thread_archived";

export interface ThreadRoleState {
  role: string;
  threadId: string | null;
  title: string | null;
  archived: boolean | null;
  generation: number;
  since: number | null;
}

export class ThreadRoleError extends Error {
  readonly code: ThreadRoleErrorCode;
  readonly details: { current?: ThreadRoleState };

  constructor(
    code: ThreadRoleErrorCode,
    message: string,
    details: { current?: ThreadRoleState } = {},
  ) {
    super(message);
    this.name = "ThreadRoleError";
    this.code = code;
    this.details = details;
  }
}

export interface ThreadRoleActor {
  updatedByKind: ThreadRoleUpdatedByKind;
  updatedByThreadId?: string | null;
}

export interface ClaimThreadRoleArgs extends ThreadRoleActor {
  role: string;
  threadId: string;
}

export interface TransferThreadRoleArgs extends ThreadRoleActor {
  role: string;
  toThreadId: string;
  expectedGeneration: number;
}

export interface ReleaseThreadRoleArgs extends ThreadRoleActor {
  role: string;
  expectedGeneration: number;
}

export interface ReleaseRolesForDeletedThreadsResult {
  released: Array<{ role: string; threadId: string; generation: number }>;
}

class ThreadRoleInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ThreadRoleInvariantError";
  }
}

function assertRoleName(role: string): void {
  if (!threadRoleNameSchema.safeParse(role).success) {
    throw new ThreadRoleError(
      "invalid_role_name",
      "Role names match [a-z0-9-]+",
    );
  }
}

function immediate<T>(
  db: ThreadRoleConnection,
  work: (tx: DbQueryConnection) => T,
): T {
  const connection = db as DbConnection;
  if (rootConnectionOf(db) === db) {
    return connection.transaction((tx) => work(tx), { behavior: "immediate" });
  }
  return work(db);
}

function readState(db: DbQueryConnection, role: string): ThreadRoleState {
  const row = db
    .select({
      role: threadRoles.role,
      threadId: threadRoles.threadId,
      title: threads.title,
      titleFallback: threads.titleFallback,
      archivedAt: threads.archivedAt,
      generation: threadRoles.generation,
      since: threadRoles.since,
    })
    .from(threadRoles)
    .leftJoin(threads, eq(threads.id, threadRoles.threadId))
    .where(eq(threadRoles.role, role))
    .get();
  if (!row) {
    return {
      role,
      threadId: null,
      title: null,
      archived: null,
      generation: 0,
      since: null,
    };
  }
  return toState(row);
}

function toState(row: {
  role: string;
  threadId: string | null;
  title: string | null;
  titleFallback: string | null;
  archivedAt: number | null;
  generation: number;
  since: number;
}): ThreadRoleState {
  if (row.threadId === null) {
    return {
      role: row.role,
      threadId: null,
      title: null,
      archived: null,
      generation: row.generation,
      since: row.since,
    };
  }
  return {
    role: row.role,
    threadId: row.threadId,
    title: row.title ?? row.titleFallback,
    archived: row.archivedAt !== null,
    generation: row.generation,
    since: row.since,
  };
}

function requireLiveThread(
  tx: DbQueryConnection,
  threadId: string,
  current: ThreadRoleState,
): void {
  const thread = tx
    .select({
      deletedAt: threads.deletedAt,
      archivedAt: threads.archivedAt,
    })
    .from(threads)
    .where(eq(threads.id, threadId))
    .get();
  if (!thread) {
    throw new ThreadRoleError("thread_not_found", "Thread not found", {
      current,
    });
  }
  if (thread.deletedAt !== null) {
    throw new ThreadRoleError("thread_deleted", "Thread is deleted", {
      current,
    });
  }
  if (thread.archivedAt !== null) {
    throw new ThreadRoleError("thread_archived", "Thread is archived", {
      current,
    });
  }
}

function assertGenerationHeadroom(
  generation: number,
  current: ThreadRoleState,
): void {
  if (generation >= threadRoleMaxGeneration) {
    throw new ThreadRoleError(
      "role_generation_exhausted",
      "Role generation counter is exhausted",
      { current },
    );
  }
}

export function getThreadRole(
  db: ThreadRoleConnection,
  role: string,
): ThreadRoleState {
  assertRoleName(role);
  return readState(db, role);
}

export function listThreadRoles(db: ThreadRoleConnection): ThreadRoleState[] {
  return db
    .select({
      role: threadRoles.role,
      threadId: threadRoles.threadId,
      title: threads.title,
      titleFallback: threads.titleFallback,
      archivedAt: threads.archivedAt,
      generation: threadRoles.generation,
      since: threadRoles.since,
    })
    .from(threadRoles)
    .leftJoin(threads, eq(threads.id, threadRoles.threadId))
    .orderBy(asc(threadRoles.role))
    .all()
    .map(toState);
}

export function claimThreadRole(
  db: ThreadRoleConnection,
  args: ClaimThreadRoleArgs,
): ThreadRoleState {
  assertRoleName(args.role);
  return immediate(db, (tx) => {
    const now = Date.now();
    const before = readState(tx, args.role);
    requireLiveThread(tx, args.threadId, before);
    const inserted = tx
      .insert(threadRoles)
      .values({
        role: args.role,
        threadId: args.threadId,
        generation: 1,
        since: now,
        updatedAt: now,
        updatedByKind: args.updatedByKind,
        updatedByThreadId: args.updatedByThreadId ?? null,
      })
      .onConflictDoNothing({ target: threadRoles.role })
      .run();
    if (inserted.changes === 1) return readState(tx, args.role);
    assertGenerationHeadroom(before.generation, before);
    const claimed = tx
      .update(threadRoles)
      .set({
        threadId: args.threadId,
        generation: sql`${threadRoles.generation} + 1`,
        since: now,
        updatedAt: now,
        updatedByKind: args.updatedByKind,
        updatedByThreadId: args.updatedByThreadId ?? null,
      })
      .where(and(eq(threadRoles.role, args.role), isNull(threadRoles.threadId)))
      .run();
    if (claimed.changes === 1) return readState(tx, args.role);
    throw new ThreadRoleError("role_held", "Role is already held", {
      current: readState(tx, args.role),
    });
  });
}

export function transferThreadRole(
  db: ThreadRoleConnection,
  args: TransferThreadRoleArgs,
): ThreadRoleState {
  assertRoleName(args.role);
  return immediate(db, (tx) => {
    const current = readState(tx, args.role);
    requireLiveThread(tx, args.toThreadId, current);
    const row = tx
      .select({
        threadId: threadRoles.threadId,
        generation: threadRoles.generation,
      })
      .from(threadRoles)
      .where(eq(threadRoles.role, args.role))
      .get();
    if (!row) {
      throw new ThreadRoleError("role_not_found", "Role does not exist", {
        current,
      });
    }
    if (row.threadId === null) {
      throw new ThreadRoleError("role_not_held", "Role is not held", {
        current,
      });
    }
    if (row.generation !== args.expectedGeneration) {
      throw new ThreadRoleError(
        "role_generation_conflict",
        "Role generation changed",
        { current },
      );
    }
    if (row.threadId === args.toThreadId) return current;
    assertGenerationHeadroom(row.generation, current);
    const now = Date.now();
    const updated = tx
      .update(threadRoles)
      .set({
        threadId: args.toThreadId,
        generation: sql`${threadRoles.generation} + 1`,
        since: now,
        updatedAt: now,
        updatedByKind: args.updatedByKind,
        updatedByThreadId: args.updatedByThreadId ?? null,
      })
      .where(
        and(
          eq(threadRoles.role, args.role),
          eq(threadRoles.generation, args.expectedGeneration),
          isNotNull(threadRoles.threadId),
        ),
      )
      .run();
    if (updated.changes !== 1) {
      throw new ThreadRoleInvariantError(
        "Role transfer changed an unexpected number of rows",
      );
    }
    return readState(tx, args.role);
  });
}

export function releaseThreadRole(
  db: ThreadRoleConnection,
  args: ReleaseThreadRoleArgs,
): ThreadRoleState {
  assertRoleName(args.role);
  return immediate(db, (tx) => {
    const current = readState(tx, args.role);
    const row = tx
      .select({
        threadId: threadRoles.threadId,
        generation: threadRoles.generation,
      })
      .from(threadRoles)
      .where(eq(threadRoles.role, args.role))
      .get();
    if (!row) {
      throw new ThreadRoleError("role_not_found", "Role does not exist", {
        current,
      });
    }
    if (row.threadId === null) {
      throw new ThreadRoleError("role_not_held", "Role is not held", {
        current,
      });
    }
    if (row.generation !== args.expectedGeneration) {
      throw new ThreadRoleError(
        "role_generation_conflict",
        "Role generation changed",
        { current },
      );
    }
    assertGenerationHeadroom(row.generation, current);
    const now = Date.now();
    const updated = tx
      .update(threadRoles)
      .set({
        threadId: null,
        generation: sql`${threadRoles.generation} + 1`,
        since: now,
        updatedAt: now,
        updatedByKind: args.updatedByKind,
        updatedByThreadId: args.updatedByThreadId ?? null,
      })
      .where(
        and(
          eq(threadRoles.role, args.role),
          eq(threadRoles.generation, args.expectedGeneration),
          isNotNull(threadRoles.threadId),
        ),
      )
      .run();
    if (updated.changes !== 1) {
      throw new ThreadRoleInvariantError(
        "Role release changed an unexpected number of rows",
      );
    }
    return readState(tx, args.role);
  });
}

export function releaseRolesForDeletedThreads(
  tx: DbQueryConnection,
  threadIds: readonly string[],
): ReleaseRolesForDeletedThreadsResult {
  if (threadIds.length === 0) return { released: [] };
  const now = Date.now();
  const held = tx
    .select({
      role: threadRoles.role,
      threadId: threadRoles.threadId,
      generation: threadRoles.generation,
    })
    .from(threadRoles)
    .where(inArray(threadRoles.threadId, [...threadIds]))
    .all();
  const released: ReleaseRolesForDeletedThreadsResult["released"] = [];
  for (const row of held) {
    if (row.threadId === null) continue;
    assertGenerationHeadroom(row.generation, readState(tx, row.role));
    const updated = tx
      .update(threadRoles)
      .set({
        threadId: null,
        generation: sql`${threadRoles.generation} + 1`,
        since: now,
        updatedAt: now,
        updatedByKind: "system",
        updatedByThreadId: null,
      })
      .where(
        and(
          eq(threadRoles.role, row.role),
          eq(threadRoles.threadId, row.threadId),
        ),
      )
      .run();
    if (updated.changes !== 1) {
      throw new ThreadRoleInvariantError(
        "Role release on delete changed an unexpected number of rows",
      );
    }
    released.push({
      role: row.role,
      threadId: row.threadId,
      generation: row.generation + 1,
    });
  }
  return { released };
}
