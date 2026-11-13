import { events, listQueuedThreadMessages } from "@bb/db";
import { turnScope, type ThreadEvent } from "@bb/domain";
import { groupHostDaemonEvents } from "@bb/host-daemon-contract";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { internalAuthHeaders } from "../helpers/commands.js";
import { seedThreadFixture, seedThreadRuntimeState } from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";
import { appendThreadEvent } from "../../src/services/threads/thread-events.js";

describe("wake outcomes at real ingestion boundaries", () => {
  it("keeps ingestion snapshots and HTTP coverage unknown without a telemetry guarantee", async () => {
    await withTestHarness(async (harness) => {
      const { thread, session } = seedThreadFixture(harness);
      const base = {
        threadId: thread.id,
        providerThreadId: "unknown-adapter",
        scope: turnScope("coverage-turn"),
      };
      const post = (batch: ThreadEvent[]) =>
        harness.app.request("/internal/session/events", {
          method: "POST",
          headers: internalAuthHeaders(harness),
          body: JSON.stringify({
            sessionId: session.id,
            eventGroups: groupHostDaemonEvents(
              batch.map((event) => ({ threadId: thread.id, event })),
            ),
          }),
        });
      expect(
        (
          await post([
            { ...base, type: "turn/started" },
            { ...base, type: "turn/completed", status: "completed" },
          ])
        ).status,
      ).toBe(200);
      const report = async () => {
        const response = await harness.app.request(
          `/api/v1/threads/${thread.id}/wake-outcomes`,
        );
        expect(response.status).toBe(200);
        return response.json();
      };
      const unknown = {
        toolCount: null,
        changedAnything: "unknown",
        coverage: { tools: "unknown", effects: "unknown" },
      };
      expect(await report()).toMatchObject({
        outcomes: [unknown],
        summary: { unknownEffectRate: 1 },
      });
      const snapshots = () =>
        harness.db
          .select()
          .from(events)
          .where(eq(events.threadId, thread.id))
          .all()
          .filter(
            (row) =>
              row.type === "system/operation" &&
              JSON.parse(row.data).operation === "wake.turn-outcome.v1",
          );
      const sealed = snapshots();
      expect(sealed).toHaveLength(1);
      expect(JSON.parse(sealed[0]!.data).metadata).toMatchObject(unknown);
      expect(
        (
          await post([
            {
              ...base,
              type: "item/completed",
              item: {
                type: "fileRead",
                id: "late-read",
                path: "example.txt",
                status: "completed",
              },
            },
          ])
        ).status,
      ).toBe(200);
      expect(await report()).toMatchObject({ outcomes: [unknown] });
      expect(
        (
          await post([
            {
              ...base,
              type: "item/completed",
              item: {
                type: "fileChange",
                id: "late-diff",
                status: "completed",
                approvalStatus: null,
                changes: [
                  {
                    path: "example.txt",
                    kind: "update",
                    diff: "@@ -1 +1 @@\n-old\n+new\n",
                  },
                ],
              },
            },
          ])
        ).status,
      ).toBe(200);
      expect(await report()).toMatchObject({
        outcomes: [
          {
            toolCount: null,
            changedAnything: true,
            effectKinds: ["file"],
            coverage: { tools: "unknown", effects: "unknown" },
          },
        ],
      });
      harness.db
        .delete(events)
        .where(
          and(
            eq(events.threadId, thread.id),
            eq(events.turnId, "coverage-turn"),
            eq(events.type, "item/completed"),
          ),
        )
        .run();
      expect(await report()).toMatchObject({ outcomes: [unknown] });
      expect(snapshots()).toEqual(sealed);
    });
  });

  it("seals on completion before any report read and recomputes late file observations", async () => {
    await withTestHarness(async (harness) => {
      const { thread, session } = seedThreadFixture(harness);
      const base = {
        threadId: thread.id,
        providerThreadId: "example-provider",
        scope: turnScope("turn-1"),
      };
      const post = (batch: ThreadEvent[]) =>
        harness.app.request("/internal/session/events", {
          method: "POST",
          headers: internalAuthHeaders(harness),
          body: JSON.stringify({
            sessionId: session.id,
            eventGroups: groupHostDaemonEvents(
              batch.map((event) => ({ threadId: thread.id, event })),
            ),
          }),
        });
      const batch: ThreadEvent[] = [
        { ...base, type: "turn/started" },
        { ...base, type: "turn/completed", status: "completed" },
      ];
      expect((await post(batch)).status).toBe(200);
      const snapshots = () =>
        harness.db
          .select()
          .from(events)
          .where(eq(events.threadId, thread.id))
          .all()
          .filter(
            (row) =>
              row.type === "system/operation" &&
              JSON.parse(row.data).operation === "wake.turn-outcome.v1",
          );
      const sealed = snapshots();
      expect(sealed).toHaveLength(1);
      expect(JSON.parse(sealed[0]!.data).metadata).toMatchObject({
        origin: "settlement",
        changedAnything: "unknown",
        toolCount: null,
        coverage: { tools: "unknown", effects: "unknown" },
      });
      expect((await post(batch)).status).toBe(200);
      expect(
        (
          await post([
            {
              ...base,
              type: "item/completed",
              item: {
                type: "fileChange",
                id: "late-write",
                status: "completed",
                approvalStatus: null,
                changes: [
                  {
                    path: "example.txt",
                    kind: "update",
                    diff: "@@ -1 +1 @@\n-old\n+new\n",
                  },
                ],
              },
            },
          ])
        ).status,
      ).toBe(200);
      const response = await harness.app.request(
        `/api/v1/threads/${thread.id}/wake-outcomes`,
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        outcomes: [
          {
            toolCount: null,
            changedAnything: true,
            effectKinds: ["file"],
            coverage: { tools: "unknown", effects: "unknown" },
          },
        ],
        summary: { unknownEffectRate: 0 },
      });
      expect(snapshots()).toEqual(sealed);
    });
  });

  it("does not infer an originating turn from a successfully accepted outbound send", async () => {
    await withTestHarness(async (harness) => {
      const { thread: sender } = seedThreadFixture(harness);
      const { thread: recipient } = seedThreadFixture(harness);
      seedThreadRuntimeState(harness.deps, {
        threadId: recipient.id,
        environmentId: recipient.environmentId,
        providerThreadId: "recipient-provider",
      });
      appendThreadEvent(harness.deps, {
        threadId: sender.id,
        scope: turnScope("sender-turn"),
        type: "turn/started",
        data: { providerThreadId: "example-provider" },
      });
      appendThreadEvent(harness.deps, {
        threadId: sender.id,
        scope: turnScope("sender-turn"),
        type: "item/completed",
        data: {
          providerThreadId: "example-provider",
          item: {
            type: "toolCall",
            id: "send-call",
            tool: "send",
            status: "completed",
          },
        },
      });
      const response = await harness.app.request(
        `/api/v1/threads/${recipient.id}/send`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            input: [{ type: "text", text: "Example message", mentions: [] }],
            mode: "queue-if-active",
            senderThreadId: sender.id,
            sendAt: Date.now() + 60000,
          }),
        },
      );
      const body: unknown = await response.json();
      expect(response.status, JSON.stringify(body)).toBe(200);
      expect(body).toMatchObject({ ok: true, delivery: "queued" });
      expect(listQueuedThreadMessages(harness.db, recipient.id)).toMatchObject([
        { senderThreadId: sender.id },
      ]);
      appendThreadEvent(harness.deps, {
        threadId: sender.id,
        scope: turnScope("sender-turn"),
        type: "turn/completed",
        data: { providerThreadId: "example-provider", status: "completed" },
      });
      const report = await harness.app.request(
        `/api/v1/threads/${sender.id}/wake-outcomes`,
      );
      expect(report.status).toBe(200);
      expect(await report.json()).toMatchObject({
        outcomes: [
          {
            toolCount: null,
            changedAnything: "unknown",
            effectKinds: [],
            coverage: { tools: "unknown", effects: "unknown" },
          },
        ],
        summary: { unknownEffectRate: 1 },
      });
      expect(
        harness.db
          .select()
          .from(events)
          .where(
            and(
              eq(events.threadId, sender.id),
              eq(events.type, "system/operation"),
            ),
          )
          .all()
          .filter((row) => JSON.parse(row.data).operation === "wake.effect.v1"),
      ).toEqual([]);
    });
  });
});
