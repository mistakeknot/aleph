import {
  claimQueuedThreadMessage,
  createQueuedThreadMessage,
  listQueuedThreadMessages,
} from "@bb/db";
import { describe, expect, it } from "vitest";
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

function enqueue(harness: TestAppHarness, threadId: string, text: string) {
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

  it.each([
    { name: "self_transfer", reason: "self_transfer" },
    { name: "source_has_claims", reason: "source_has_claims" },
  ])(
    "refuses $name with a thread_not_writable envelope and burns no key",
    async ({ name, reason }) => {
      await withTestHarness(async (harness) => {
        const { source, target } = seedPair(harness, `retire-${name}`);
        const row = enqueue(harness, source.id, "a");
        if (reason === "source_has_claims") {
          claimQueuedThreadMessage(harness.db, harness.hub, row.id);
        }
        const response = await post(harness, `/threads/${source.id}/retire`, {
          targetThreadId: reason === "self_transfer" ? source.id : target.id,
          operationKey: "k1",
        });
        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({
          code: "thread_not_writable",
          details: { reason },
        });
      });
    },
    20_000,
  );

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

  it("serves GET and ack, and refuses another project's operation", async () => {
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
      harness.db.$client
        .prepare(
          "INSERT INTO thread_redirects (source_thread_id, successor_thread_id, op_id) VALUES (?, ?, ?)",
        )
        .run(target.id, source.id, retired.operationId);
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
});
