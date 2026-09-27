import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { noopNotifier } from "../../src/notifier.js";
import { createEnvironment } from "../../src/data/environments.js";
import { upsertHost } from "../../src/data/hosts.js";
import { createProject } from "../../src/data/projects.js";
import { createThread, markThreadDeleted } from "../../src/data/threads.js";
import {
  listLearnedThreadMatches,
  recordThreadSearchSelection,
} from "../../src/data/thread-search-learned-selections.js";
import type { DbConnection } from "../../src/connection.js";
import { createMigratedConnection } from "../helpers/migrated-connection.js";

function setup() {
  const db = createMigratedConnection();
  const host = upsertHost(db, noopNotifier, { name: "host-a" });
  const { project } = createProject(db, noopNotifier, {
    name: "project-a",
    source: { type: "local_path", hostId: host.id, path: "/tmp/a" },
  });
  const environment = createEnvironment(db, noopNotifier, {
    providerOwnsPath: false,
    hostId: host.id,
    projectId: project.id,
    path: "/tmp/a",
  });
  const makeThread = (overrides: { visibility?: "visible" | "hidden" } = {}) =>
    createThread(db, noopNotifier, {
      environmentId: environment.id,
      projectId: project.id,
      providerId: "codex",
      status: "active",
      ...overrides,
    });
  return { db, makeThread };
}

/** A pair must be picked at least twice before it counts as a habit. */
function pick(db: DbConnection, query: string, threadId: string, times = 2) {
  for (let i = 0; i < times; i++) {
    recordThreadSearchSelection(db, { query, threadId });
  }
}

function learnedIds(db: DbConnection, queryPrefix: string): string[] {
  return listLearnedThreadMatches(db, { queryPrefix, now: Date.now() }).map(
    (match) => match.threadId,
  );
}

describe("thread search learned selections", () => {
  let db: DbConnection;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    db.$client.close();
    vi.useRealTimers();
  });

  it("returns nothing when nothing has been learned for a prefix", () => {
    ({ db } = setup());
    expect(learnedIds(db, "af")).toEqual([]);
  });

  it("matches a stored full query by its typed prefix", () => {
    const { db: setupDb, makeThread } = setup();
    db = setupDb;
    const thread = makeThread();
    pick(db, "afternoon standup", thread.id);
    expect(learnedIds(db, "af")).toEqual([thread.id]);
    expect(learnedIds(db, "bafoon")).toEqual([]);
  });

  it("treats LIKE wildcards in the typed prefix literally", () => {
    const { db: setupDb, makeThread } = setup();
    db = setupDb;
    const underscored = makeThread();
    pick(db, "cmdk_switcher", underscored.id);
    const percent = makeThread();
    pick(db, "100% done", percent.id);
    const lookalike = makeThread();
    pick(db, "cmdkxswitcher", lookalike.id);
    pick(db, "100x done", lookalike.id);

    expect(learnedIds(db, "cmdk_sw")).toEqual([underscored.id]);
    expect(learnedIds(db, "100%")).toEqual([percent.id]);
    expect(learnedIds(db, "_")).toEqual([]);
    expect(learnedIds(db, "%")).toEqual([]);
  });

  it("ignores a single one-off pick", () => {
    const { db: setupDb, makeThread } = setup();
    db = setupDb;
    const thread = makeThread();
    recordThreadSearchSelection(db, { query: "af", threadId: thread.id });
    expect(learnedIds(db, "af")).toEqual([]);
    recordThreadSearchSelection(db, { query: "af", threadId: thread.id });
    expect(learnedIds(db, "af")).toEqual([thread.id]);
  });

  it("increments the counter instead of duplicating rows on repeat selection", () => {
    const { db: setupDb, makeThread } = setup();
    db = setupDb;
    const thread = makeThread();
    pick(db, "af", thread.id, 3);
    const other = makeThread();
    // A different stored query sharing the typed prefix, so the newest-habit
    // demotion (exact query only) doesn't apply.
    pick(db, "afternoon", other.id, 2);

    // Three selections beat two made at the same instant.
    expect(learnedIds(db, "af")).toEqual([thread.id, other.id]);
    expect(
      db.$client
        .prepare("SELECT COUNT(*) AS n FROM thread_search_learned_selections")
        .get(),
    ).toEqual({ n: 2 });
  });

  it("ranks a fresh habit above a heavily-decayed frequent one", () => {
    const { db: setupDb, makeThread } = setup();
    db = setupDb;
    const frequent = makeThread();
    const now = Date.now();
    vi.setSystemTime(now - 60 * 24 * 60 * 60 * 1000); // 60 days ago
    pick(db, "afternoon", frequent.id, 5);
    vi.setSystemTime(now);
    const recent = makeThread();
    pick(db, "af", recent.id, 2);

    // Five picks decayed across ~4 half-lives score ~0.26, below two fresh
    // picks.
    expect(learnedIds(db, "af")).toEqual([recent.id, frequent.id]);
  });

  it("skips deleted and hidden threads so the next-best live thread leads", () => {
    const { db: setupDb, makeThread } = setup();
    db = setupDb;
    const hidden = makeThread({ visibility: "hidden" });
    pick(db, "af", hidden.id, 5);
    const doomed = makeThread();
    pick(db, "af", doomed.id, 4);
    const live = makeThread();
    pick(db, "af", live.id, 2);
    db.$client
      .prepare("UPDATE threads SET deleted_at = ? WHERE id = ?")
      .run(Date.now(), doomed.id);

    expect(learnedIds(db, "af")).toEqual([live.id]);
  });

  it("forgets a thread's picks when the thread is deleted", () => {
    const { db: setupDb, makeThread } = setup();
    db = setupDb;
    const thread = makeThread();
    pick(db, "af", thread.id);
    markThreadDeleted(db, noopNotifier, { threadId: thread.id });

    expect(
      db.$client
        .prepare(
          "SELECT COUNT(*) AS n FROM thread_search_learned_selections WHERE thread_id = ?",
        )
        .get(thread.id),
    ).toEqual({ n: 0 });
  });

  it("prunes picks that have not been reinforced within the retention window", () => {
    const { db: setupDb, makeThread } = setup();
    db = setupDb;
    const stale = makeThread();
    const now = Date.now();
    vi.setSystemTime(now - 91 * 24 * 60 * 60 * 1000);
    pick(db, "af", stale.id);
    vi.setSystemTime(now);
    const fresh = makeThread();
    pick(db, "fresh", fresh.id);

    expect(learnedIds(db, "af")).toEqual([]);
    expect(learnedIds(db, "fresh")).toEqual([fresh.id]);
  });

  it("lets a new habit overtake a strong old one for the same query within two picks", () => {
    const { db: setupDb, makeThread } = setup();
    db = setupDb;
    const oldHabit = makeThread();
    const newHabit = makeThread();
    const now = Date.now();
    vi.setSystemTime(now - 7 * 24 * 60 * 60 * 1000);
    pick(db, "bbdev", oldHabit.id, 10);
    vi.setSystemTime(now);

    pick(db, "bbdev", newHabit.id, 1);
    expect(learnedIds(db, "bbdev")).toEqual([oldHabit.id]);

    pick(db, "bbdev", newHabit.id, 1);
    expect(learnedIds(db, "bbdev")[0]).toBe(newHabit.id);
    // The chosen thread's own count keeps climbing; only rivals are halved.
    expect(
      db.$client
        .prepare(
          "SELECT selection_count AS n FROM thread_search_learned_selections WHERE query_text = ? AND thread_id = ?",
        )
        .get("bbdev", newHabit.id),
    ).toEqual({ n: 2 });
  });

  it("only demotes other threads' picks for the exact same query", () => {
    const { db: setupDb, makeThread } = setup();
    db = setupDb;
    const first = makeThread();
    const second = makeThread();
    pick(db, "bbdev", first.id, 4);
    pick(db, "bbdevops", first.id, 4);

    pick(db, "bbdev", second.id, 1);

    const counts = db.$client
      .prepare(
        "SELECT query_text AS query, selection_count AS n FROM thread_search_learned_selections WHERE thread_id = ? ORDER BY query_text",
      )
      .all(first.id);
    expect(counts).toEqual([
      { query: "bbdev", n: 2 },
      { query: "bbdevops", n: 4 },
    ]);
  });

  it("drops a competing pick once its count reaches zero", () => {
    const { db: setupDb, makeThread } = setup();
    db = setupDb;
    const oneOff = makeThread();
    const chosen = makeThread();
    pick(db, "bbdev", oneOff.id, 1);

    pick(db, "bbdev", chosen.id, 1);

    expect(
      db.$client
        .prepare(
          "SELECT count(*) AS n FROM thread_search_learned_selections WHERE thread_id = ?",
        )
        .get(oneOff.id),
    ).toEqual({ n: 0 });
  });

  it("ignores picks older than the retention window even when nothing has pruned them", () => {
    const { db: setupDb, makeThread } = setup();
    db = setupDb;
    const idle = makeThread();
    const recent = makeThread();
    const now = Date.now();
    vi.setSystemTime(now - 91 * 24 * 60 * 60 * 1000);
    pick(db, "af", idle.id);
    vi.setSystemTime(now - 89 * 24 * 60 * 60 * 1000);
    pick(db, "re", recent.id);
    // No later write, so the write-time prune never ran.
    vi.setSystemTime(now);

    expect(
      db.$client
        .prepare(
          "SELECT count(*) AS n FROM thread_search_learned_selections WHERE thread_id = ?",
        )
        .get(idle.id),
    ).toEqual({ n: 1 });
    expect(learnedIds(db, "af")).toEqual([]);
    expect(learnedIds(db, "re")).toEqual([recent.id]);
  });
});
