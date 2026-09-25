import { z } from "zod";
import { describe, expect, it } from "vitest";
import {
  acknowledgeIdempotentThreadOperation,
  reconcileIdempotentThreadOperation,
  recordIdempotentThreadOperationFailure,
  recordIdempotentThreadOperationSuccess,
  reopenIdempotentThreadOperation,
} from "../../src/services/threads/spawn-enqueue-idempotency.js";
import { createTestDb } from "../helpers/test-app.js";

const spawnResultSchema = z.object({ threadId: z.string() });

describe("spawn/enqueue idempotency ledger", () => {
  it("reserves a fresh key as new", () => {
    const db = createTestDb();
    const outcome = reconcileIdempotentThreadOperation(
      { db },
      {
        scope: "thread-spawn",
        idempotencyKey: "key-1",
        sendAt: null,
        resultSchema: spawnResultSchema,
      },
    );
    expect(outcome.kind).toBe("new");
  });

  it("reports a second reconcile against an unfinished key as in-flight, not a second new operation", () => {
    const db = createTestDb();
    const first = reconcileIdempotentThreadOperation(
      { db },
      {
        scope: "thread-spawn",
        idempotencyKey: "key-2",
        sendAt: null,
        resultSchema: spawnResultSchema,
      },
    );
    const second = reconcileIdempotentThreadOperation(
      { db },
      {
        scope: "thread-spawn",
        idempotencyKey: "key-2",
        sendAt: null,
        resultSchema: spawnResultSchema,
      },
    );
    expect(first.kind).toBe("new");
    expect(second.kind).toBe("in-flight");
  });

  it("replays the original result and sendAt for a retry after completion, ignoring the retry's own sendAt", () => {
    const db = createTestDb();
    const originalSendAt = 1_000;
    const first = reconcileIdempotentThreadOperation(
      { db },
      {
        scope: "thread-spawn",
        idempotencyKey: "key-3",
        sendAt: originalSendAt,
        resultSchema: spawnResultSchema,
      },
    );
    expect(first.kind).toBe("new");
    recordIdempotentThreadOperationSuccess(
      { db },
      {
        scope: "thread-spawn",
        idempotencyKey: "key-3",
        result: { threadId: "thr_original" },
      },
    );

    const retry = reconcileIdempotentThreadOperation(
      { db },
      {
        scope: "thread-spawn",
        idempotencyKey: "key-3",
        sendAt: 9_999_999,
        resultSchema: spawnResultSchema,
      },
    );
    expect(retry).toEqual({
      kind: "replay",
      result: { threadId: "thr_original" },
      sendAt: originalSendAt,
    });
  });

  it("keeps replaying the same result after the caller acknowledges it", () => {
    const db = createTestDb();
    reconcileIdempotentThreadOperation(
      { db },
      {
        scope: "message-enqueue",
        idempotencyKey: "key-4",
        sendAt: null,
        resultSchema: z.object({ queuedMessageId: z.string() }),
      },
    );
    recordIdempotentThreadOperationSuccess(
      { db },
      {
        scope: "message-enqueue",
        idempotencyKey: "key-4",
        result: { queuedMessageId: "qmsg_1" },
      },
    );
    acknowledgeIdempotentThreadOperation(
      { db },
      { scope: "message-enqueue", idempotencyKey: "key-4" },
    );

    const replay = reconcileIdempotentThreadOperation(
      { db },
      {
        scope: "message-enqueue",
        idempotencyKey: "key-4",
        sendAt: null,
        resultSchema: z.object({ queuedMessageId: z.string() }),
      },
    );
    expect(replay).toEqual({
      kind: "replay",
      result: { queuedMessageId: "qmsg_1" },
      sendAt: null,
    });
  });

  it("reports a failed operation as failed rather than silently retrying it", () => {
    const db = createTestDb();
    reconcileIdempotentThreadOperation(
      { db },
      {
        scope: "thread-spawn",
        idempotencyKey: "key-5",
        sendAt: null,
        resultSchema: spawnResultSchema,
      },
    );
    recordIdempotentThreadOperationFailure(
      { db },
      {
        scope: "thread-spawn",
        idempotencyKey: "key-5",
        errorMessage: "provider unavailable",
      },
    );

    const outcome = reconcileIdempotentThreadOperation(
      { db },
      {
        scope: "thread-spawn",
        idempotencyKey: "key-5",
        sendAt: null,
        resultSchema: spawnResultSchema,
      },
    );
    expect(outcome).toEqual({
      kind: "failed",
      errorMessage: "provider unavailable",
      sendAt: null,
    });
  });

  it("reopening a failed key preserves its original sendAt and reports new exactly once", () => {
    const db = createTestDb();
    const originalSendAt = 5_000;
    reconcileIdempotentThreadOperation(
      { db },
      {
        scope: "thread-spawn",
        idempotencyKey: "key-6",
        sendAt: originalSendAt,
        resultSchema: spawnResultSchema,
      },
    );
    recordIdempotentThreadOperationFailure(
      { db },
      {
        scope: "thread-spawn",
        idempotencyKey: "key-6",
        errorMessage: "host offline",
      },
    );

    const reopened = reopenIdempotentThreadOperation(
      { db },
      { scope: "thread-spawn", idempotencyKey: "key-6" },
    );
    expect(reopened).toEqual({ kind: "new", sendAt: originalSendAt });

    const secondReopen = reopenIdempotentThreadOperation(
      { db },
      { scope: "thread-spawn", idempotencyKey: "key-6" },
    );
    expect(secondReopen).toBeNull();

    const inFlight = reconcileIdempotentThreadOperation(
      { db },
      {
        scope: "thread-spawn",
        idempotencyKey: "key-6",
        sendAt: 42,
        resultSchema: spawnResultSchema,
      },
    );
    expect(inFlight).toEqual({ kind: "in-flight", sendAt: originalSendAt });
  });

  it("keeps thread-spawn and message-enqueue keys independent even when the caller reuses the same string", () => {
    const db = createTestDb();
    reconcileIdempotentThreadOperation(
      { db },
      {
        scope: "thread-spawn",
        idempotencyKey: "shared-key",
        sendAt: null,
        resultSchema: spawnResultSchema,
      },
    );
    const enqueueOutcome = reconcileIdempotentThreadOperation(
      { db },
      {
        scope: "message-enqueue",
        idempotencyKey: "shared-key",
        sendAt: null,
        resultSchema: z.object({ queuedMessageId: z.string() }),
      },
    );
    expect(enqueueOutcome.kind).toBe("new");
  });
});
