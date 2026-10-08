import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import {
  createConnection,
  getEnvironment,
  getThread,
  listEvents,
  migrate,
  QueuedMessageThreadUnavailableError,
} from "@bb/db";
import type { ResolvedThreadExecutionOptions } from "@bb/domain";
import { afterEach, describe, expect, it } from "vitest";
import { requestThreadTargetReprovision } from "../../src/services/threads/thread-provisioning.js";
import { textInput } from "../helpers/prompt-input.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
} from "../helpers/seed.js";
import { createTestAppHarness } from "../helpers/test-app.js";

const EXECUTION = {
  model: "gpt-5",
  serviceTier: "default",
  reasoningLevel: "medium",
  permissionMode: "accept-edits",
  source: "client/turn/requested",
} satisfies ResolvedThreadExecutionOptions;

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

function openFileBackedDeps() {
  const dir = mkdtempSync(join(tmpdir(), "bb-reprovision-lock-"));
  const dbPath = join(dir, "bb.db");
  const db = createConnection(dbPath);
  migrate(db);
  cleanups.push(() => {
    db.$client.close();
    rmSync(dir, { force: true, recursive: true });
  });
  return { db, dbPath };
}

async function seedReprovisionFixture() {
  const harness = await createTestAppHarness();
  cleanups.push(() => harness.cleanup());
  const { db, dbPath } = openFileBackedDeps();
  const deps = { db, hub: harness.deps.hub };
  const { host } = seedHostSession(deps, { id: "host-reprovision-lock" });
  const { project } = seedProjectWithSource(deps, {
    hostId: host.id,
    path: "/tmp/reprovision-lock",
  });
  const environment = seedEnvironment(deps, {
    hostId: host.id,
    projectId: project.id,
    path: "/tmp/reprovision-lock",
    status: "error",
    environmentProviderId: "personal-workspace",
    environmentProviderPluginId: "bb-plugin-environment-personal-workspace",
    isGitRepo: false,
  });
  const thread = seedThread(deps, {
    projectId: project.id,
    environmentId: environment.id,
    status: "idle",
  });
  const second = new Database(dbPath);
  second.pragma("busy_timeout = 0");
  cleanups.push(() => {
    second.close();
  });
  const row = getEnvironment(db, environment.id);
  if (row === null || row.environmentProviderSelection === null) {
    throw new Error("expected a reprovisionable environment");
  }

  return {
    db,
    deps,
    row,
    second,
    selection: row.environmentProviderSelection,
    thread,
  };
}

describe("requestThreadTargetReprovision write reservation", () => {
  it("holds the write lock from its lifecycle reread so a second connection cannot archive between reread and write", async () => {
    const { db, deps, row, second, selection, thread } =
      await seedReprovisionFixture();

    let secondConnectionError: unknown = null;
    let refusal: unknown = null;
    try {
      requestThreadTargetReprovision(deps, {
        beforeRequestAppendInTransaction: ({ tx }) => {
          const current = getThread(tx, thread.id);
          if (current === null || current.archivedAt !== null) {
            throw new QueuedMessageThreadUnavailableError(
              thread.id,
              "archived",
            );
          }
          try {
            second
              .prepare("UPDATE threads SET archived_at = ? WHERE id = ?")
              .run(Date.now(), thread.id);
          } catch (error) {
            secondConnectionError = error;
          }
        },
        environment: row,
        execution: EXECUTION,
        initiator: "system",
        input: textInput("child finished"),
        provider: {
          environmentProviderId: "personal-workspace",
          selection,
        },
        senderThreadId: null,
        thread,
      });
    } catch (error) {
      refusal = error;
    }

    expect(refusal).toBeNull();
    expect(secondConnectionError).toMatchObject({ code: "SQLITE_BUSY" });
    expect(getThread(db, thread.id)?.archivedAt).toBeNull();
  });

  it("refuses when a second connection archived the thread before the entry point opened its transaction", async () => {
    const { db, deps, row, second, selection, thread } =
      await seedReprovisionFixture();
    second
      .prepare("UPDATE threads SET archived_at = ? WHERE id = ?")
      .run(Date.now(), thread.id);

    expect(() =>
      requestThreadTargetReprovision(deps, {
        beforeRequestAppendInTransaction: ({ tx }) => {
          if (getThread(tx, thread.id)?.archivedAt !== null) {
            throw new QueuedMessageThreadUnavailableError(
              thread.id,
              "archived",
            );
          }
        },
        environment: row,
        execution: EXECUTION,
        initiator: "system",
        input: textInput("child finished"),
        provider: {
          environmentProviderId: "personal-workspace",
          selection,
        },
        senderThreadId: null,
        thread,
      }),
    ).toThrow(QueuedMessageThreadUnavailableError);
    expect(
      listEvents(db, { threadId: thread.id }).filter(
        (event) => event.type === "client/turn/requested",
      ),
    ).toEqual([]);
  });
});
