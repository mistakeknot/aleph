import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { noopNotifier } from "../../src/notifier.js";
import { threadRoles, threads } from "../../src/schema.js";
import { archiveThread, unarchiveThread } from "../../src/data/threads.js";
import {
  ThreadRoleError,
  claimThreadRole,
  getThreadRole,
  listThreadRoles,
  releaseThreadRole,
  transferThreadRole,
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

const actor = { updatedByKind: "cli" } as const;

function errorOf(work: () => unknown): ThreadRoleError {
  try {
    work();
  } catch (error) {
    if (error instanceof ThreadRoleError) return error;
    throw error;
  }
  throw new Error("expected ThreadRoleError");
}

describe("thread roles data layer", () => {
  it("returns the unheld shape for a role that never existed", () => {
    const { db } = setup();
    expect(getThreadRole(db, "vizier")).toEqual({
      role: "vizier",
      threadId: null,
      title: null,
      archived: null,
      generation: 0,
      since: null,
    });
    expect(listThreadRoles(db)).toEqual([]);
  });

  it("claims an unheld role and reports the holder", () => {
    const { db, project } = setup();
    const thread = makeThread(db, project.id, "Vizier");
    const state = claimThreadRole(db, {
      ...actor,
      role: "vizier",
      threadId: thread.id,
    });
    expect(state).toMatchObject({
      role: "vizier",
      threadId: thread.id,
      title: "Vizier",
      archived: false,
      generation: 1,
    });
    expect(typeof state.since).toBe("number");
  });

  it("falls back to the title fallback when the thread has no title", () => {
    const { db, project } = setup();
    const thread = makeThread(db, project.id);
    db.update(threads)
      .set({ titleFallback: "Fallback" })
      .where(eq(threads.id, thread.id))
      .run();
    const state = claimThreadRole(db, {
      ...actor,
      role: "vizier",
      threadId: thread.id,
    });
    expect(state.title).toBe("Fallback");
  });

  it("rejects a claim on a held role, even by the current holder", () => {
    const { db, project } = setup();
    const a = makeThread(db, project.id);
    const b = makeThread(db, project.id);
    claimThreadRole(db, { ...actor, role: "vizier", threadId: a.id });
    for (const threadId of [a.id, b.id]) {
      const error = errorOf(() =>
        claimThreadRole(db, { ...actor, role: "vizier", threadId }),
      );
      expect(error.code).toBe("role_held");
      expect(error.details.current).toMatchObject({
        threadId: a.id,
        generation: 1,
      });
    }
  });

  it("lets an archived holder block a claim until the role is transferred", () => {
    const { db, project } = setup();
    const a = makeThread(db, project.id);
    const b = makeThread(db, project.id);
    claimThreadRole(db, { ...actor, role: "vizier", threadId: a.id });
    archiveThread(db, noopNotifier, a.id);
    expect(getThreadRole(db, "vizier").archived).toBe(true);
    expect(
      errorOf(() =>
        claimThreadRole(db, { ...actor, role: "vizier", threadId: b.id }),
      ).code,
    ).toBe("role_held");
    const moved = transferThreadRole(db, {
      ...actor,
      role: "vizier",
      toThreadId: b.id,
      expectedGeneration: 1,
    });
    expect(moved).toMatchObject({ threadId: b.id, generation: 2 });
  });

  it("keeps the role when its holder is archived and unarchived", () => {
    const { db, project } = setup();
    const a = makeThread(db, project.id);
    claimThreadRole(db, { ...actor, role: "vizier", threadId: a.id });
    archiveThread(db, noopNotifier, a.id);
    unarchiveThread(db, noopNotifier, a.id);
    expect(getThreadRole(db, "vizier")).toMatchObject({
      threadId: a.id,
      archived: false,
      generation: 1,
    });
  });

  it("rejects missing, deleted and archived claimants", () => {
    const { db, project } = setup();
    const archived = makeThread(db, project.id);
    archiveThread(db, noopNotifier, archived.id);
    const deleted = makeThread(db, project.id);
    db.update(threads)
      .set({ deletedAt: Date.now() })
      .where(eq(threads.id, deleted.id))
      .run();
    expect(
      errorOf(() =>
        claimThreadRole(db, { ...actor, role: "r", threadId: "thr_missing" }),
      ).code,
    ).toBe("thread_not_found");
    expect(
      errorOf(() =>
        claimThreadRole(db, { ...actor, role: "r", threadId: deleted.id }),
      ).code,
    ).toBe("thread_deleted");
    expect(
      errorOf(() =>
        claimThreadRole(db, { ...actor, role: "r", threadId: archived.id }),
      ).code,
    ).toBe("thread_archived");
    expect(listThreadRoles(db)).toEqual([]);
  });

  it("rejects invalid role names before touching the database", () => {
    const { db, project } = setup();
    const a = makeThread(db, project.id);
    for (const role of ["", "Vizier", "a_b", "a b", "é"]) {
      expect(
        errorOf(() => claimThreadRole(db, { ...actor, role, threadId: a.id }))
          .code,
      ).toBe("invalid_role_name");
    }
  });

  it("transfers with the generation check and reports a no-op without a bump", () => {
    const { db, project } = setup();
    const a = makeThread(db, project.id);
    const b = makeThread(db, project.id);
    claimThreadRole(db, { ...actor, role: "vizier", threadId: a.id });
    const same = transferThreadRole(db, {
      ...actor,
      role: "vizier",
      toThreadId: a.id,
      expectedGeneration: 1,
    });
    expect(same.generation).toBe(1);
    const stale = errorOf(() =>
      transferThreadRole(db, {
        ...actor,
        role: "vizier",
        toThreadId: a.id,
        expectedGeneration: 7,
      }),
    );
    expect(stale.code).toBe("role_generation_conflict");
    expect(stale.details.current?.generation).toBe(1);
    const moved = transferThreadRole(db, {
      ...actor,
      role: "vizier",
      toThreadId: b.id,
      expectedGeneration: 1,
      updatedByThreadId: a.id,
    });
    expect(moved).toMatchObject({ threadId: b.id, generation: 2 });
    const row = db.select().from(threadRoles).get();
    expect(row?.updatedByKind).toBe("cli");
    expect(row?.updatedByThreadId).toBe(a.id);
  });

  it("reports role_not_found and role_not_held for transfer and release", () => {
    const { db, project } = setup();
    const a = makeThread(db, project.id);
    expect(
      errorOf(() =>
        transferThreadRole(db, {
          ...actor,
          role: "vizier",
          toThreadId: a.id,
          expectedGeneration: 1,
        }),
      ).code,
    ).toBe("role_not_found");
    expect(
      errorOf(() =>
        releaseThreadRole(db, { ...actor, role: "vizier", expectedGeneration: 1 }),
      ).code,
    ).toBe("role_not_found");
    claimThreadRole(db, { ...actor, role: "vizier", threadId: a.id });
    releaseThreadRole(db, { ...actor, role: "vizier", expectedGeneration: 1 });
    expect(
      errorOf(() =>
        transferThreadRole(db, {
          ...actor,
          role: "vizier",
          toThreadId: a.id,
          expectedGeneration: 2,
        }),
      ).code,
    ).toBe("role_not_held");
    expect(
      errorOf(() =>
        releaseThreadRole(db, { ...actor, role: "vizier", expectedGeneration: 2 }),
      ).code,
    ).toBe("role_not_held");
  });

  it("checks the generation before the no-op on transfer", () => {
    const { db, project } = setup();
    const a = makeThread(db, project.id);
    claimThreadRole(db, { ...actor, role: "vizier", threadId: a.id });
    expect(
      errorOf(() =>
        transferThreadRole(db, {
          ...actor,
          role: "vizier",
          toThreadId: a.id,
          expectedGeneration: 2,
        }),
      ).code,
    ).toBe("role_generation_conflict");
  });

  it("validates the transfer target", () => {
    const { db, project } = setup();
    const a = makeThread(db, project.id);
    claimThreadRole(db, { ...actor, role: "vizier", threadId: a.id });
    const archived = makeThread(db, project.id);
    archiveThread(db, noopNotifier, archived.id);
    expect(
      errorOf(() =>
        transferThreadRole(db, {
          ...actor,
          role: "vizier",
          toThreadId: archived.id,
          expectedGeneration: 1,
        }),
      ).code,
    ).toBe("thread_archived");
    expect(
      errorOf(() =>
        transferThreadRole(db, {
          ...actor,
          role: "vizier",
          toThreadId: "thr_missing",
          expectedGeneration: 1,
        }),
      ).code,
    ).toBe("thread_not_found");
  });

  it("releases with a generation bump and keeps the generation monotonic across reclaim", () => {
    const { db, project } = setup();
    const a = makeThread(db, project.id);
    const b = makeThread(db, project.id);
    claimThreadRole(db, { ...actor, role: "vizier", threadId: a.id });
    const released = releaseThreadRole(db, {
      ...actor,
      role: "vizier",
      expectedGeneration: 1,
    });
    expect(released).toMatchObject({
      threadId: null,
      title: null,
      archived: null,
      generation: 2,
    });
    expect(typeof released.since).toBe("number");
    const reclaimed = claimThreadRole(db, {
      ...actor,
      role: "vizier",
      threadId: b.id,
    });
    expect(reclaimed).toMatchObject({ threadId: b.id, generation: 3 });
    expect(
      errorOf(() =>
        releaseThreadRole(db, { ...actor, role: "vizier", expectedGeneration: 1 }),
      ).code,
    ).toBe("role_generation_conflict");
  });

  it("lists roles in role order including unheld rows", () => {
    const { db, project } = setup();
    const a = makeThread(db, project.id, "A");
    claimThreadRole(db, { ...actor, role: "zeta", threadId: a.id });
    claimThreadRole(db, { ...actor, role: "alpha", threadId: a.id });
    releaseThreadRole(db, { ...actor, role: "zeta", expectedGeneration: 1 });
    const list = listThreadRoles(db);
    expect(list.map((entry) => entry.role)).toEqual(["alpha", "zeta"]);
    expect(list[1]).toMatchObject({ threadId: null, generation: 2 });
  });

  it("refuses to bump a generation past the safe-integer ceiling", () => {
    const { db, project } = setup();
    const a = makeThread(db, project.id);
    const b = makeThread(db, project.id);
    claimThreadRole(db, { ...actor, role: "vizier", threadId: a.id });
    db.update(threadRoles)
      .set({ generation: Number.MAX_SAFE_INTEGER })
      .where(eq(threadRoles.role, "vizier"))
      .run();
    expect(
      errorOf(() =>
        transferThreadRole(db, {
          ...actor,
          role: "vizier",
          toThreadId: b.id,
          expectedGeneration: Number.MAX_SAFE_INTEGER,
        }),
      ).code,
    ).toBe("role_generation_exhausted");
    expect(
      errorOf(() =>
        releaseThreadRole(db, {
          ...actor,
          role: "vizier",
          expectedGeneration: Number.MAX_SAFE_INTEGER,
        }),
      ).code,
    ).toBe("role_generation_exhausted");
    expect(getThreadRole(db, "vizier").generation).toBe(
      Number.MAX_SAFE_INTEGER,
    );
  });

  it("rolls a role mutation back with its enclosing transaction", () => {
    const { db, project } = setup();
    const a = makeThread(db, project.id);
    expect(() =>
      db.transaction((tx) => {
        claimThreadRole(tx, { ...actor, role: "vizier", threadId: a.id });
        throw new Error("abort");
      }),
    ).toThrow("abort");
    expect(listThreadRoles(db)).toEqual([]);
  });
});
