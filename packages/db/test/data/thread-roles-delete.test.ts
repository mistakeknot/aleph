import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { noopNotifier } from "../../src/notifier.js";
import type { DbNotifier } from "../../src/notifier.js";
import { projects, threadRoles, threads } from "../../src/schema.js";
import { createThread, markThreadDeleted } from "../../src/data/threads.js";
import {
  claimThreadRole,
  getThreadRole,
  releaseRolesForDeletedThreads,
} from "../../src/data/thread-roles.js";
import { makeThread, setupRoles } from "../helpers/thread-roles.js";

const open: Array<{ $client: { close(): void } }> = [];
afterEach(() => {
  for (const db of open.splice(0)) db.$client.close();
});

function setup() {
  const ctx = setupRoles();
  open.push(ctx.db);
  return ctx;
}

const actor = { updatedByKind: "api" } as const;

function recordingNotifier(events: string[]): DbNotifier {
  return {
    ...noopNotifier,
    notifyThread(threadId, changes) {
      events.push(`thread:${threadId}:${changes.join(",")}`);
    },
    notifyProject(projectId, changes) {
      events.push(`project:${projectId}:${changes.join(",")}`);
    },
  };
}

describe("release on delete", () => {
  it("releases the role of a soft-deleted thread with a system bump", () => {
    const { db, project } = setup();
    const a = makeThread(db, project.id);
    claimThreadRole(db, {
      ...actor,
      role: "vizier",
      threadId: a.id,
      updatedByThreadId: a.id,
    });
    const returned = markThreadDeleted(db, noopNotifier, { threadId: a.id });
    expect(returned?.id).toBe(a.id);
    expect(returned?.deletedAt).not.toBeNull();
    expect(getThreadRole(db, "vizier")).toMatchObject({
      threadId: null,
      generation: 2,
    });
    const row = db.select().from(threadRoles).get();
    expect(row?.updatedByKind).toBe("system");
    expect(row?.updatedByThreadId).toBeNull();
  });

  it("releases roles held anywhere in the deletion tree", () => {
    const { db, project } = setup();
    const root = makeThread(db, project.id);
    const child = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
      status: "idle",
      lifecycleOwnerThreadId: root.id,
    });
    const other = makeThread(db, project.id);
    claimThreadRole(db, { ...actor, role: "a", threadId: root.id });
    claimThreadRole(db, { ...actor, role: "b", threadId: child.id });
    claimThreadRole(db, { ...actor, role: "c", threadId: other.id });
    markThreadDeleted(db, noopNotifier, { threadId: root.id });
    expect(getThreadRole(db, "a").threadId).toBeNull();
    expect(getThreadRole(db, "b").threadId).toBeNull();
    expect(getThreadRole(db, "c")).toMatchObject({
      threadId: other.id,
      generation: 1,
    });
  });

  it("is idempotent when the thread is already deleted", () => {
    const { db, project } = setup();
    const a = makeThread(db, project.id);
    claimThreadRole(db, { ...actor, role: "vizier", threadId: a.id });
    markThreadDeleted(db, noopNotifier, { threadId: a.id });
    markThreadDeleted(db, noopNotifier, { threadId: a.id });
    expect(getThreadRole(db, "vizier").generation).toBe(2);
  });

  it("returns the released roles from the sibling function", () => {
    const { db, project } = setup();
    const a = makeThread(db, project.id);
    claimThreadRole(db, { ...actor, role: "vizier", threadId: a.id });
    expect(
      db.transaction((tx) => releaseRolesForDeletedThreads(tx, [a.id])),
    ).toEqual({
      released: [{ role: "vizier", threadId: a.id, generation: 2 }],
    });
    expect(
      db.transaction((tx) => releaseRolesForDeletedThreads(tx, [a.id])),
    ).toEqual({ released: [] });
    expect(
      db.transaction((tx) => releaseRolesForDeletedThreads(tx, [])),
    ).toEqual({ released: [] });
  });
});

describe("release on hard delete", () => {
  it("clears the holder and bumps the generation through the trigger", () => {
    const { db, project } = setup();
    const a = makeThread(db, project.id);
    claimThreadRole(db, { ...actor, role: "vizier", threadId: a.id });
    const before = Date.now();
    db.delete(threads).where(eq(threads.id, a.id)).run();
    const row = db.select().from(threadRoles).get();
    expect(row).toMatchObject({
      threadId: null,
      generation: 2,
      updatedByKind: "system",
      updatedByThreadId: null,
    });
    expect(row!.since).toBeGreaterThanOrEqual(before - 1000);
    expect(row!.updatedAt).toBeGreaterThanOrEqual(before - 1000);
  });

  it("clears holders when a project cascades its threads away", () => {
    const { db, project } = setup();
    const a = makeThread(db, project.id);
    claimThreadRole(db, { ...actor, role: "vizier", threadId: a.id });
    db.delete(projects).where(eq(projects.id, project.id)).run();
    expect(getThreadRole(db, "vizier")).toMatchObject({
      threadId: null,
      generation: 2,
    });
  });

  it("does not double count an explicit release", () => {
    const { db, project } = setup();
    const a = makeThread(db, project.id);
    claimThreadRole(db, { ...actor, role: "vizier", threadId: a.id });
    markThreadDeleted(db, noopNotifier, { threadId: a.id });
    db.delete(threads).where(eq(threads.id, a.id)).run();
    expect(getThreadRole(db, "vizier").generation).toBe(2);
  });
});

describe("markThreadDeleted commit boundary", () => {
  it("sends notifications only after the role release is committed", () => {
    const { db, project } = setup();
    const a = makeThread(db, project.id);
    claimThreadRole(db, { ...actor, role: "vizier", threadId: a.id });
    const seen: Array<string | null> = [];
    const notifier: DbNotifier = {
      ...noopNotifier,
      notifyThread() {
        seen.push(getThreadRole(db, "vizier").threadId);
      },
    };
    markThreadDeleted(db, notifier, { threadId: a.id });
    expect(seen).toEqual([null]);
  });

  it("queues notifications until the outer transaction commits", () => {
    const { db, project } = setup();
    const a = makeThread(db, project.id);
    const events: string[] = [];
    db.transaction((tx) => {
      markThreadDeleted(tx, recordingNotifier(events), { threadId: a.id });
      expect(events).toEqual([]);
    });
    expect(events).toEqual([
      `thread:${a.id}:thread-deleted`,
      `project:${project.id}:threads-changed`,
    ]);
  });

  it("drops notifications and the release when the outer transaction rolls back", () => {
    const { db, project } = setup();
    const a = makeThread(db, project.id);
    claimThreadRole(db, { ...actor, role: "vizier", threadId: a.id });
    const events: string[] = [];
    expect(() =>
      db.transaction((tx) => {
        markThreadDeleted(tx, recordingNotifier(events), { threadId: a.id });
        throw new Error("abort");
      }),
    ).toThrow("abort");
    expect(events).toEqual([]);
    expect(getThreadRole(db, "vizier")).toMatchObject({
      threadId: a.id,
      generation: 1,
    });
    expect(
      db.select().from(threads).where(eq(threads.id, a.id)).get()?.deletedAt,
    ).toBeNull();
  });
});
