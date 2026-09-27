import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { noopNotifier } from "../../src/notifier.js";
import { createEnvironment } from "../../src/data/environments.js";
import { upsertHost } from "../../src/data/hosts.js";
import { createProject } from "../../src/data/projects.js";
import { createThread } from "../../src/data/threads.js";
import {
  findTopLearnedThreadMatch,
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
  const makeThread = () =>
    createThread(db, noopNotifier, {
      environmentId: environment.id,
      projectId: project.id,
      providerId: "codex",
      status: "active",
    });
  return { db, makeThread };
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

  it("returns null when nothing has been learned for a prefix", () => {
    ({ db } = setup());
    expect(
      findTopLearnedThreadMatch(db, { queryPrefix: "af", now: Date.now() }),
    ).toBeNull();
  });

  it("matches a stored full query by its typed prefix", () => {
    const { db: setupDb, makeThread } = setup();
    db = setupDb;
    const thread = makeThread();
    recordThreadSearchSelection(db, {
      query: "afternoon standup",
      threadId: thread.id,
    });
    expect(
      findTopLearnedThreadMatch(db, { queryPrefix: "af", now: Date.now() }),
    ).toEqual({ threadId: thread.id, score: expect.any(Number) });
    expect(
      findTopLearnedThreadMatch(db, { queryPrefix: "bafoon", now: Date.now() }),
    ).toBeNull();
  });

  it("increments the counter instead of duplicating rows on repeat selection", () => {
    const { db: setupDb, makeThread } = setup();
    db = setupDb;
    const thread = makeThread();
    recordThreadSearchSelection(db, { query: "af", threadId: thread.id });
    recordThreadSearchSelection(db, { query: "af", threadId: thread.id });
    recordThreadSearchSelection(db, { query: "af", threadId: thread.id });
    const other = makeThread();
    recordThreadSearchSelection(db, { query: "af", threadId: other.id });

    const match = findTopLearnedThreadMatch(db, {
      queryPrefix: "af",
      now: Date.now(),
    });
    // Three selections beats one, so the thrice-picked thread wins even
    // though both were selected at the same instant.
    expect(match).toEqual({ threadId: thread.id, score: expect.any(Number) });
  });

  it("prefers a heavily-decayed frequent pick over a fresh single pick appropriately", () => {
    const { db: setupDb, makeThread } = setup();
    db = setupDb;
    const frequent = makeThread();
    const now = Date.now();
    vi.setSystemTime(now - 60 * 24 * 60 * 60 * 1000); // 60 days ago
    for (let i = 0; i < 5; i++) {
      recordThreadSearchSelection(db, { query: "af", threadId: frequent.id });
    }
    vi.setSystemTime(now);
    const recent = makeThread();
    recordThreadSearchSelection(db, { query: "af", threadId: recent.id });

    const match = findTopLearnedThreadMatch(db, { queryPrefix: "af", now });
    // A single very recent pick should outrank five picks decayed to
    // near-zero after ~60 days against a 14-day half-life.
    expect(match?.threadId).toBe(recent.id);
  });
});
