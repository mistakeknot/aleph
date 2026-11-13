import {
  cpSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection } from "../src/connection.js";
import { migrateWithFolders } from "../src/migrate.js";
import { sourceFolders } from "./helpers/plan-apply.js";
import { describe, expect, it } from "vitest";
import { PERSONAL_PROJECT_ID } from "@bb/domain";
import { queuedMessageWakeSchema } from "@bb/domain";
import { createMigratedConnection } from "../src/testing.js";
import { createThread, noopNotifier, migrate } from "../src/index.js";
import {
  createQueuedThreadMessage,
  getQueuedThreadMessage,
} from "../src/data/queued-thread-messages.js";

describe("queue wake attribution", () => {
  it("upgrades legacy inline, scheduled retry and coalesced rows without changing messages", () => {
    const folder = mkdtempSync(join(tmpdir(), "queue-wake-upgrade-"));
    cpSync(sourceFolders.alephFolder, folder, { recursive: true });
    const manifestPath = join(folder, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      steps: { id: string }[];
    };
    manifest.steps = manifest.steps.filter((step) => step.id !== "A0015");
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const db = createConnection(":memory:");
    try {
      migrateWithFolders(db, { ...sourceFolders, alephFolder: folder });
      const thread = createThread(db, noopNotifier, {
        projectId: PERSONAL_PROJECT_ID,
        providerId: "test",
        status: "idle",
      });
      for (const [id, state, payload, coalesce] of [
        ["inline", "queued", "inline", null],
        ["scheduled-retry", "scheduled", "retry", null],
        ["coalesced", "queued", "inline", "notice"],
      ] as const) {
        db.$client
          .prepare(
            `INSERT INTO queued_thread_messages (id, thread_id, content, model, reasoning_level, permission_mode, service_tier, state, payload_kind, coalesce_key, coalesce_state, sort_key, created_at, updated_at, send_at, waiting_on, retry_of_turn_request_id, retry_attempt, retry_reason) VALUES (?, ?, ?, 'test', 'medium', 'full', 'default', ?, ?, ?, ?, ?, 1, 1, ?, ?, ?, ?, ?)`,
          )
          .run(
            id,
            thread.id,
            JSON.stringify([{ type: "text", text: id, mentions: [] }]),
            state,
            payload,
            coalesce,
            coalesce ? '{"sources":["notice"]}' : null,
            id,
            state === "scheduled" ? 999999 : null,
            state === "scheduled" ? '{"kind":"time"}' : null,
            payload === "retry" ? "request-original" : null,
            payload === "retry" ? 2 : null,
            payload === "retry" ? "retry later" : null,
          );
      }
      const before = db.$client
        .prepare("SELECT * FROM queued_thread_messages ORDER BY id")
        .all();
      migrate(db);
      const after = db.$client
        .prepare("SELECT * FROM queued_thread_messages ORDER BY id")
        .all();
      expect(after).toEqual(
        before.map((row) => ({
          ...(row as object),
          wake_cause: "unknown",
          wake_ref: null,
        })),
      );
      for (const id of ["inline", "scheduled-retry", "coalesced"])
        expect(getQueuedThreadMessage(db, id)).toMatchObject({
          wakeCause: "unknown",
          wakeRef: null,
        });
    } finally {
      db.$client.close();
      rmSync(folder, { recursive: true, force: true });
    }
  });
  it("defaults legacy attribution and validates the closed enum and bounded ref", () => {
    expect(queuedMessageWakeSchema.parse({})).toEqual({
      wakeCause: "unknown",
      wakeRef: null,
    });
    expect(
      queuedMessageWakeSchema.safeParse({ wakeCause: "invented" }).success,
    ).toBe(false);
    expect(
      queuedMessageWakeSchema.safeParse({ wakeRef: "x".repeat(201) }).success,
    ).toBe(false);
    expect(
      queuedMessageWakeSchema.parse({
        wakeCause: "card_pick",
        wakeRef: "x".repeat(200),
      }).wakeRef,
    ).toHaveLength(200);
  });
  it("has migrated column defaults and round trips attributed queue rows", () => {
    const db = createMigratedConnection();
    try {
      const columns = db.$client
        .prepare("PRAGMA table_info(queued_thread_messages)")
        .all();
      expect(columns).toContainEqual(
        expect.objectContaining({
          name: "wake_cause",
          notnull: 1,
          dflt_value: "'unknown'",
        }),
      );
      expect(columns).toContainEqual(
        expect.objectContaining({ name: "wake_ref", notnull: 0 }),
      );
      const thread = createThread(db, noopNotifier, {
        projectId: PERSONAL_PROJECT_ID,
        providerId: "test",
        status: "idle",
      });
      const input = {
        threadId: thread.id,
        content: [
          { type: "text" as const, text: "keep this message", mentions: [] },
        ],
        model: "test",
        reasoningLevel: "medium",
        permissionMode: "full" as const,
        serviceTier: "default",
        waitingOn: null,
        sendAt: null,
        payload: { kind: "inline" as const },
        systemNotice: null,
      };
      const row = createQueuedThreadMessage(db, noopNotifier, {
        ...input,
        wakeCause: "card_pick",
        wakeRef: "pick-1",
      });
      expect(getQueuedThreadMessage(db, row.id)).toMatchObject({
        wakeCause: "card_pick",
        wakeRef: "pick-1",
        content: JSON.stringify(input.content),
      });
      expect(createQueuedThreadMessage(db, noopNotifier, input)).toMatchObject({
        wakeCause: "unknown",
        wakeRef: null,
      });
    } finally {
      db.$client.close();
    }
  });
});
