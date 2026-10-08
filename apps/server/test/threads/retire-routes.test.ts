import {
  ONLINE_QUEUE_MOVE_MAX_ROWS,
  claimQueuedThreadMessage,
  createQueuedThreadMessage,
  getTransferOperation,
  listQueuedThreadMessages,
  retireQueuedThreadMessages,
} from "@bb/db";
import { runStartupRecoverySweep } from "../../src/services/system/periodic-sweeps.js";
import { describe, expect, it, vi } from "vitest";
import { textInput } from "../helpers/prompt-input.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
} from "../helpers/seed.js";
import { type TestAppHarness, withTestHarness } from "../helpers/test-app.js";

function seedPair(harness: TestAppHarness, name: string) {
  const { host } = seedHostSession(harness.deps, { id: `host-${name}` });
  const { project } = seedProjectWithSource(harness.deps, {
    hostId: host.id,
    path: `/tmp/${name}`,
  });
  const environment = seedEnvironment(harness.deps, {
    hostId: host.id,
    projectId: project.id,
    path: `/tmp/${name}`,
    status: "ready",
  });
  const source = seedThread(harness.deps, {
    projectId: project.id,
    environmentId: environment.id,
    status: "active",
  });
  const target = seedThread(harness.deps, {
    projectId: project.id,
    environmentId: environment.id,
    status: "active",
  });
  return { project, source, target };
}

function enqueue(
  harness: TestAppHarness,
  threadId: string,
  text: string,
  overrides: Partial<Parameters<typeof createQueuedThreadMessage>[2]> = {},
) {
  return createQueuedThreadMessage(harness.db, harness.hub, {
    threadId,
    content: textInput(text),
    model: "gpt-5",
    reasoningLevel: "medium",
    permissionMode: "full",
    serviceTier: "default",
    waitingOn: { kind: "thread-busy" },
    sendAt: null,
    payload: { kind: "inline" },
    systemNotice: null,
    ...overrides,
  });
}

function post(harness: TestAppHarness, path: string, body: unknown) {
  return harness.app.request(`/api/v1${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("retire routes", () => {
  it("moves inline rows and replays the stored result for the same key", async () => {
    await withTestHarness(async (harness) => {
      const { source, target } = seedPair(harness, "retire-ok");
      const first = enqueue(harness, source.id, "a");
      enqueue(harness, source.id, "b");
      const response = await post(harness, `/threads/${source.id}/retire`, {
        targetThreadId: target.id,
        operationKey: "k1",
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        operationId: string;
        moved: { id: string; newId: string; originId: string }[];
      };
      expect(body.moved).toHaveLength(2);
      expect(body.moved[0]).toMatchObject({ id: first.id, originId: first.id });
      expect(listQueuedThreadMessages(harness.db, source.id)).toEqual([]);
      expect(listQueuedThreadMessages(harness.db, target.id)).toHaveLength(2);
      const replay = await post(harness, `/threads/${source.id}/retire`, {
        targetThreadId: target.id,
        operationKey: "k1",
      });
      expect(replay.status).toBe(200);
      expect(await replay.json()).toEqual(body);
    });
  }, 20_000);

  it("answers a different request under the same key with idempotency_conflict", async () => {
    await withTestHarness(async (harness) => {
      const { source, target } = seedPair(harness, "retire-conflict");
      enqueue(harness, source.id, "a");
      await post(harness, `/threads/${source.id}/retire`, {
        targetThreadId: target.id,
        operationKey: "k1",
      });
      const other = seedThread(harness.deps, {
        projectId: source.projectId,
        environmentId: source.environmentId,
        status: "active",
      });
      const response = await post(harness, `/threads/${source.id}/retire`, {
        targetThreadId: other.id,
        operationKey: "k1",
      });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        code: "idempotency_conflict",
      });
    });
  }, 20_000);

  it("refuses self_transfer with a thread_not_writable envelope", async () => {
    await withTestHarness(async (harness) => {
      const { source } = seedPair(harness, "retire-self");
      enqueue(harness, source.id, "a");
      const response = await post(harness, `/threads/${source.id}/retire`, {
        targetThreadId: source.id,
        operationKey: "k1",
      });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        code: "thread_not_writable",
        details: { reason: "self_transfer" },
      });
    });
  }, 20_000);

  it("refuses a source over the row maximum with a thread_not_writable envelope and moves nothing", async () => {
    await withTestHarness(async (harness) => {
      const { source, target } = seedPair(harness, "retire-too-large");
      harness.db.$client
        .prepare(
          `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<${ONLINE_QUEUE_MOVE_MAX_ROWS + 1}) INSERT INTO queued_thread_messages (id,origin_id,thread_id,content,model,reasoning_level,permission_mode,service_tier,group_with_next,payload_kind,sort_key,created_at,updated_at) SELECT 'bulk'||i,'bulk'||i,?,'[]','m','r','full','default',0,'inline',printf('k%08d',i),1,1 FROM n`,
        )
        .run(source.id);
      const response = await post(harness, `/threads/${source.id}/retire`, {
        targetThreadId: target.id,
        operationKey: "k1",
      });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        code: "thread_not_writable",
        details: { reason: "source_queue_too_large" },
      });
      expect(listQueuedThreadMessages(harness.db, source.id)).toHaveLength(
        ONLINE_QUEUE_MOVE_MAX_ROWS + 1,
      );
      expect(listQueuedThreadMessages(harness.db, target.id)).toEqual([]);
    });
  }, 30_000);

  it("retires a source with a claimed row by forwarding it through a slot", async () => {
    await withTestHarness(async (harness) => {
      const { source, target } = seedPair(harness, "retire-claimed");
      const row = enqueue(harness, source.id, "a");
      claimQueuedThreadMessage(harness.db, harness.hub, row.id);
      const response = await post(harness, `/threads/${source.id}/retire`, {
        targetThreadId: target.id,
        operationKey: "k1",
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        moved: unknown[];
        pending: { id: string }[];
      };
      expect(body.moved).toEqual([]);
      expect(body.pending.map((p) => p.id)).toEqual([row.id]);
    });
  }, 20_000);

  it("refuses a missing source with unknown_thread", async () => {
    await withTestHarness(async (harness) => {
      const { target } = seedPair(harness, "retire-unknown");
      const response = await post(harness, `/threads/thr_missing/retire`, {
        targetThreadId: target.id,
        operationKey: "k1",
      });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        code: "thread_not_writable",
        details: { reason: "unknown_thread" },
      });
    });
  }, 20_000);

  it("serves GET and ack, and answers 404 for an unknown operation", async () => {
    await withTestHarness(async (harness) => {
      const { source, target } = seedPair(harness, "retire-get");
      enqueue(harness, source.id, "a");
      const retired = (await (
        await post(harness, `/threads/${source.id}/retire`, {
          targetThreadId: target.id,
          operationKey: "k1",
        })
      ).json()) as { operationId: string };
      const got = await harness.app.request(
        `/api/v1/transfer-operations/${retired.operationId}`,
      );
      expect(got.status).toBe(200);
      expect(await got.json()).toMatchObject({
        id: retired.operationId,
        state: "active",
        entries: [{ kind: "moved", state: "terminal" }],
      });
      const missing = await harness.app.request(
        `/api/v1/transfer-operations/top_missing`,
      );
      expect(missing.status).toBe(404);
      const acked = await post(
        harness,
        `/transfer-operations/${retired.operationId}/ack`,
        {},
      );
      expect(acked.status).toBe(200);
      expect(await acked.json()).toMatchObject({ acked: true });
    });
  }, 20_000);

  it("carries plugin and time waits through the real callback and resets the rest to thread-busy", async () => {
    await withTestHarness(async (harness) => {
      const { source, target } = seedPair(harness, "retire-wait");
      const sendAt = Date.now() + 60_000;
      enqueue(harness, source.id, "plugin", {
        waitingOn: { kind: "plugin", pluginId: "plug-1", reason: "approval" },
      });
      enqueue(harness, source.id, "time", {
        waitingOn: { kind: "time" },
        sendAt,
      });
      enqueue(harness, source.id, "interaction", {
        waitingOn: { kind: "interaction" },
      });
      const response = await post(harness, `/threads/${source.id}/retire`, {
        targetThreadId: target.id,
        operationKey: "k-wait",
      });
      expect(response.status).toBe(200);
      const rows = listQueuedThreadMessages(harness.db, target.id);
      expect(
        rows.map((row) => [
          row.waitingOn && JSON.parse(row.waitingOn),
          row.waitHolder,
        ]),
      ).toEqual([
        [
          { kind: "plugin", pluginId: "plug-1", reason: "approval" },
          "plugin:plug-1",
        ],
        [{ kind: "time" }, null],
        [{ kind: "thread-busy" }, null],
      ]);
      expect(rows[1]?.sendAt).toBe(sendAt);
      expect(rows[0]?.sendAt).toBeNull();
    });
  }, 20_000);

  it("drains unemitted events on startup recovery after a crash before delivery, then retains the live redirect past ack", async () => {
    await withTestHarness(async (harness) => {
      const { project, source, target } = seedPair(harness, "retire-crash");
      enqueue(harness, source.id, "a");
      const outcome = retireQueuedThreadMessages(harness.db, {
        projectId: project.id,
        sourceThreadId: source.id,
        targetThreadId: target.id,
        operationKey: "k-crash",
        retireEnabled: true,
        resolveWaitingOn: () => ({ kind: "thread-busy" }),
      });
      expect(outcome.kind).toBe("retired");
      const unemitted = () =>
        (
          harness.db.$client
            .prepare(
              "SELECT COUNT(*) AS n FROM transfer_events WHERE emitted_at IS NULL",
            )
            .get() as { n: number }
        ).n;
      expect(unemitted()).toBeGreaterThan(0);
      const notify = vi.spyOn(harness.hub, "notifyThread");
      await runStartupRecoverySweep(harness.deps);
      expect(unemitted()).toBe(0);
      expect(notify).toHaveBeenCalledWith(source.id, ["queue-changed"]);
      expect(notify).toHaveBeenCalledWith(target.id, ["queue-changed"]);
      const operationId = (outcome as { result: { operationId: string } })
        .result.operationId;
      expect(getTransferOperation(harness.db, operationId)).not.toBeNull();
      const acked = await post(
        harness,
        `/transfer-operations/${operationId}/ack`,
        {},
      );
      expect(acked.status).toBe(200);
      await runStartupRecoverySweep(harness.deps);
      expect(getTransferOperation(harness.db, operationId)).not.toBeNull();
    });
  }, 20_000);

  it("refuses a plain transfer to a retired target with target_retired", async () => {
    await withTestHarness(async (harness) => {
      const { source, target } = seedPair(harness, "retire-plain");
      const row = enqueue(harness, source.id, "a");
      const retired = (await (
        await post(harness, `/threads/${target.id}/retire`, {
          targetThreadId: source.id,
          operationKey: "k1",
        })
      ).json()) as { operationId: string };
      expect(retired.operationId).toBeTruthy();
      const response = await post(
        harness,
        `/threads/${source.id}/queued-messages/${row.id}/transfer`,
        { targetThreadId: target.id },
      );
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        code: "thread_not_writable",
        details: { reason: "target_retired" },
      });
    });
  }, 20_000);

  it("aborts a retirement over the route, returning rows to the source and replaying the stored result", async () => {
    await withTestHarness(async (harness) => {
      const { source, target } = seedPair(harness, "abort-ok");
      const row = enqueue(harness, source.id, "a");
      const retired = (await (
        await post(harness, `/threads/${source.id}/retire`, {
          targetThreadId: target.id,
          operationKey: "k1",
        })
      ).json()) as { operationId: string };
      const body = {
        operationKey: "abort-1",
        expectedRetirementOperationId: retired.operationId,
      };
      const aborted = await post(
        harness,
        `/transfer-operations/${retired.operationId}/abort`,
        body,
      );
      expect(aborted.status).toBe(200);
      const result = (await aborted.json()) as {
        returned: { originId: string }[];
      };
      expect(result.returned.map((r) => r.originId)).toEqual([row.id]);
      expect(listQueuedThreadMessages(harness.db, source.id)).toHaveLength(1);
      expect(listQueuedThreadMessages(harness.db, target.id)).toEqual([]);
      const replay = await post(
        harness,
        `/transfer-operations/${retired.operationId}/abort`,
        body,
      );
      expect(replay.status).toBe(200);
      expect(await replay.json()).toEqual(result);
      const again = await post(
        harness,
        `/transfer-operations/${retired.operationId}/abort`,
        { ...body, operationKey: "abort-2" },
      );
      expect(again.status).toBe(409);
      expect(await again.json()).toMatchObject({
        code: "thread_not_writable",
        details: { reason: "already_aborted" },
      });
    });
  }, 20_000);

  it("answers 404 when aborting an unknown operation", async () => {
    await withTestHarness(async (harness) => {
      const response = await post(
        harness,
        `/transfer-operations/top_missing/abort`,
        { operationKey: "k", expectedRetirementOperationId: "top_missing" },
      );
      expect(response.status).toBe(404);
    });
  }, 20_000);

  it("refuses retire when the kill switch is off while abort still works (T-RB1)", async () => {
    await withTestHarness(async (harness) => {
      const { source, target } = seedPair(harness, "kill-switch");
      enqueue(harness, source.id, "a");
      const retired = (await (
        await post(harness, `/threads/${source.id}/retire`, {
          targetThreadId: target.id,
          operationKey: "k1",
        })
      ).json()) as { operationId: string };
      vi.stubEnv("ALEPH_TRANSFER_RETIRE", "off");
      try {
        const other = seedThread(harness.deps, {
          projectId: source.projectId,
          environmentId: source.environmentId,
          status: "active",
        });
        enqueue(harness, other.id, "b");
        const refused = await post(harness, `/threads/${other.id}/retire`, {
          targetThreadId: target.id,
          operationKey: "k2",
        });
        expect(refused.status).toBe(409);
        expect(await refused.json()).toMatchObject({
          details: { reason: "transfer_retire_disabled" },
        });
        const aborted = await post(
          harness,
          `/transfer-operations/${retired.operationId}/abort`,
          {
            operationKey: "abort-1",
            expectedRetirementOperationId: retired.operationId,
          },
        );
        expect(aborted.status).toBe(200);
      } finally {
        vi.unstubAllEnvs();
      }
    });
  }, 20_000);

  it("redirects a post to a retired thread and, with redirect off, refuses it", async () => {
    await withTestHarness(async (harness) => {
      const { source, target } = seedPair(harness, "post-modes");
      enqueue(harness, source.id, "a");
      await post(harness, `/threads/${source.id}/retire`, {
        targetThreadId: target.id,
        operationKey: "k1",
      });
      const send = () =>
        post(harness, `/threads/${source.id}/queued-messages`, {
          input: textInput("late"),
          model: "gpt-5",
          reasoningLevel: "medium",
          permissionMode: "full",
          serviceTier: "default",
        });
      const redirected = await send();
      expect(redirected.status).toBeLessThan(300);
      expect(listQueuedThreadMessages(harness.db, target.id)).toHaveLength(2);
      vi.stubEnv("ALEPH_RETIRED_USER_POSTS", "refuse");
      try {
        const refused = await send();
        expect(refused.status).toBe(409);
        expect(await refused.json()).toMatchObject({
          details: { reason: "already_retired" },
        });
        expect(listQueuedThreadMessages(harness.db, target.id)).toHaveLength(2);
      } finally {
        vi.unstubAllEnvs();
      }
    });
  }, 20_000);
});
