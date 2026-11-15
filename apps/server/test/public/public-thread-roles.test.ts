import {
  threadRoleConflictDetailsSchema,
  threadRoleListResponseSchema,
  threadRoleStateSchema,
} from "@bb/server-contract";
import { createBbSdk } from "@bb/sdk/core";
import { createHttpTransport } from "@bb/sdk/node";
import { describe, expect, it, vi } from "vitest";
import { readJson } from "../helpers/json.js";
import { seedThreadFixture, seedThread } from "../helpers/seed.js";
import {
  withTestHarness,
  type TestAppHarness,
} from "../helpers/test-app.js";

const JSON_HEADERS = { "content-type": "application/json" };
const CLI_HEADERS = {
  ...JSON_HEADERS,
  "x-bb-cli": "1",
  "x-bb-caller-thread": "thr_asserted",
};

function post(
  harness: TestAppHarness,
  path: string,
  body: unknown,
  headers: Record<string, string> = JSON_HEADERS,
): Promise<Response> {
  return Promise.resolve(
    harness.app.request(`/api/v1/thread-roles${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }),
  );
}

function seedTwoThreads(harness: TestAppHarness, title: string | null) {
  const first = seedThreadFixture(harness, { thread: { title } });
  const second = seedThread(harness.deps, { projectId: first.project.id });
  return { first: first.thread, second };
}

function archive(harness: TestAppHarness, threadId: string): void {
  harness.db.$client
    .prepare("UPDATE threads SET archived_at = ? WHERE id = ?")
    .run(Date.now(), threadId);
}

async function readError(response: Response) {
  return (await readJson(response)) as {
    code: string;
    message: string;
    details?: unknown;
  };
}

describe("public thread roles routes", () => {
  it("answers an unheld role with a null holder and the current generation", async () => {
    await withTestHarness(async (harness) => {
      const response = await harness.app.request("/api/v1/thread-roles/ruler");
      expect(response.status).toBe(200);
      expect(threadRoleStateSchema.parse(await readJson(response))).toEqual({
        role: "ruler",
        threadId: null,
        title: null,
        archived: null,
        generation: 0,
        since: null,
      });
      const list = await harness.app.request("/api/v1/thread-roles");
      expect(list.status).toBe(200);
      expect(threadRoleListResponseSchema.parse(await readJson(list))).toEqual({
        roles: [],
      });
    });
  });

  it("claims, transfers and releases with generations moving forward", async () => {
    await withTestHarness(async (harness) => {
      const { first, second } = seedTwoThreads(harness, "Masaq' | ruler");

      const claimed = await post(harness, "/ruler/claim", {
        threadId: first.id,
      });
      expect(claimed.status).toBe(200);
      const claimedState = threadRoleStateSchema.parse(await readJson(claimed));
      expect(claimedState).toMatchObject({
        role: "ruler",
        threadId: first.id,
        title: "Masaq' | ruler",
        archived: false,
        generation: 1,
      });

      const transferred = await post(harness, "/ruler/transfer", {
        toThreadId: second.id,
        expectGeneration: claimedState.generation,
      });
      expect(transferred.status).toBe(200);
      const transferredState = threadRoleStateSchema.parse(
        await readJson(transferred),
      );
      expect(transferredState).toMatchObject({
        threadId: second.id,
        generation: 2,
      });

      const released = await post(harness, "/ruler/release", {
        expectGeneration: transferredState.generation,
      });
      expect(released.status).toBe(200);
      expect(threadRoleStateSchema.parse(await readJson(released))).toMatchObject(
        { threadId: null, title: null, archived: null, generation: 3 },
      );

      const listed = threadRoleListResponseSchema.parse(
        await readJson(await harness.app.request("/api/v1/thread-roles")),
      );
      expect(listed.roles.map((r) => [r.role, r.threadId, r.generation])).toEqual(
        [["ruler", null, 3]],
      );
    });
  });

  it("returns an archived holder with archived true and keeps the role", async () => {
    await withTestHarness(async (harness) => {
      const { first } = seedTwoThreads(harness, "Old ruler");
      await post(harness, "/ruler/claim", { threadId: first.id });
      archive(harness, first.id);

      const response = await harness.app.request("/api/v1/thread-roles/ruler");
      expect(threadRoleStateSchema.parse(await readJson(response))).toMatchObject(
        { threadId: first.id, archived: true, generation: 1 },
      );
    });
  });

  it("answers 409 with details.current for every conflict", async () => {
    await withTestHarness(async (harness) => {
      const { first, second } = seedTwoThreads(harness, "Holder");
      await post(harness, "/ruler/claim", { threadId: first.id });

      const held = await post(harness, "/ruler/claim", { threadId: second.id });
      expect(held.status).toBe(409);
      const heldError = await readError(held);
      expect(heldError.code).toBe("role_held");
      expect(
        threadRoleConflictDetailsSchema.parse(heldError.details).current,
      ).toMatchObject({ threadId: first.id, generation: 1 });

      const selfClaim = await post(harness, "/ruler/claim", {
        threadId: first.id,
      });
      expect(selfClaim.status).toBe(409);
      expect((await readError(selfClaim)).code).toBe("role_held");

      const stale = await post(harness, "/ruler/transfer", {
        toThreadId: second.id,
        expectGeneration: 0,
      });
      expect(stale.status).toBe(409);
      const staleError = await readError(stale);
      expect(staleError.code).toBe("role_generation_conflict");
      expect(
        threadRoleConflictDetailsSchema.parse(staleError.details).current,
      ).toMatchObject({ threadId: first.id, generation: 1 });

      const staleRelease = await post(harness, "/ruler/release", {
        expectGeneration: 0,
      });
      expect(staleRelease.status).toBe(409);
      expect((await readError(staleRelease)).code).toBe(
        "role_generation_conflict",
      );

      archive(harness, second.id);
      const archivedTarget = await post(harness, "/ruler/transfer", {
        toThreadId: second.id,
        expectGeneration: 1,
      });
      expect(archivedTarget.status).toBe(409);
      const archivedError = await readError(archivedTarget);
      expect(archivedError.code).toBe("thread_archived");
      expect(
        threadRoleConflictDetailsSchema.safeParse(archivedError.details).success,
      ).toBe(true);
    });
  });

  it("rejects bad role names and unknown threads and roles", async () => {
    await withTestHarness(async (harness) => {
      const { first } = seedTwoThreads(harness, "Holder");

      const badGet = await harness.app.request("/api/v1/thread-roles/Ruler");
      expect(badGet.status).toBe(400);
      expect((await readError(badGet)).code).toBe("invalid_role_name");

      const badClaim = await post(harness, "/a_b/claim", {
        threadId: first.id,
      });
      expect(badClaim.status).toBe(400);
      expect((await readError(badClaim)).code).toBe("invalid_role_name");

      const badBody = await post(harness, "/ruler/transfer", {
        toThreadId: first.id,
        expectGeneration: -1,
      });
      expect(badBody.status).toBe(400);
      expect((await readError(badBody)).code).toBe("invalid_request");

      const missingThread = await post(harness, "/ruler/claim", {
        threadId: "thr_missing",
      });
      expect(missingThread.status).toBe(404);
      expect((await readError(missingThread)).code).toBe("thread_not_found");

      const missingRole = await post(harness, "/never-held/release", {
        expectGeneration: 0,
      });
      expect(missingRole.status).toBe(404);
      expect((await readError(missingRole)).code).toBe("role_not_found");
    });
  });

  it("refuses every mutation from a plugin caller and leaves reads open", async () => {
    await withTestHarness(async (harness) => {
      const { first } = seedTwoThreads(harness, "Holder");
      await post(harness, "/ruler/claim", { threadId: first.id });
      vi.spyOn(harness.pluginService, "resolveRpcCaller").mockReturnValue({
        ok: true,
        caller: { kind: "plugin", pluginId: "some-plugin" },
      });
      const headers = { ...JSON_HEADERS, "x-bb-plugin-caller": "token" };

      for (const [path, body] of [
        ["/ruler/claim", { threadId: first.id }],
        ["/ruler/transfer", { toThreadId: first.id, expectGeneration: 1 }],
        ["/ruler/release", { expectGeneration: 1 }],
      ] as const) {
        const response = await post(harness, path, body, headers);
        expect(response.status).toBe(403);
        expect((await readError(response)).code).toBe("forbidden");
      }

      const read = await harness.app.request("/api/v1/thread-roles/ruler", {
        headers,
      });
      expect(read.status).toBe(200);
      expect(
        threadRoleStateSchema.parse(await readJson(read)).generation,
      ).toBe(1);
    });
  });

  it("maps a busy database to a retryable 503 without changing the role", async () => {
    await withTestHarness(async (harness) => {
      const { first, second } = seedTwoThreads(harness, "Holder");
      await post(harness, "/ruler/claim", { threadId: first.id });
      harness.db.$client.function("fail_busy", () => {
        throw Object.assign(new Error("database is locked"), {
          code: "SQLITE_BUSY",
        });
      });
      harness.db.$client.exec(
        "CREATE TEMP TRIGGER thread_roles_busy BEFORE UPDATE ON thread_roles BEGIN SELECT fail_busy(); END",
      );

      const response = await post(harness, "/ruler/transfer", {
        toThreadId: second.id,
        expectGeneration: 1,
      });
      expect(response.status).toBe(503);
      const body = (await readError(response)) as {
        code: string;
        retryable?: boolean;
      };
      expect(body.code).toBe("database_busy");
      expect(body.retryable).toBe(true);

      harness.db.$client.exec("DROP TRIGGER thread_roles_busy");
      const state = threadRoleStateSchema.parse(
        await readJson(await harness.app.request("/api/v1/thread-roles/ruler")),
      );
      expect(state).toMatchObject({ threadId: first.id, generation: 1 });
    });
  });

  it("logs one audit line per mutation without header values", async () => {
    await withTestHarness(async (harness) => {
      const { first, second } = seedTwoThreads(harness, "Holder");
      const info = vi.spyOn(harness.deps.logger, "info");

      await post(harness, "/ruler/claim", { threadId: first.id }, CLI_HEADERS);
      await post(
        harness,
        "/ruler/transfer",
        { toThreadId: second.id, expectGeneration: 1 },
        { ...CLI_HEADERS, authorization: "Bearer secret-token" },
      );

      const roleLines = info.mock.calls.filter(
        ([, message]) => message === "Thread role changed",
      );
      expect(roleLines).toHaveLength(2);
      expect(roleLines[1]![0]).toEqual({
        action: "transfer",
        role: "ruler",
        previousHolderObserved: first.id,
        previousGenerationObserved: 1,
        holder: second.id,
        generation: 2,
        sourceKind: "cli",
        callerThreadId: "thr_asserted",
      });
      expect(JSON.stringify(roleLines)).not.toContain("secret-token");
    });
  });

  it("keeps whitespace in a holder title", async () => {
    await withTestHarness(async (harness) => {
      const title = "Masaq'  |\tmk　channel";
      const { first } = seedTwoThreads(harness, title);
      await post(harness, "/channel/claim", { threadId: first.id });

      const state = threadRoleStateSchema.parse(
        await readJson(
          await harness.app.request("/api/v1/thread-roles/channel"),
        ),
      );
      expect(state.title).toBe(title);
    });
  });
  it("reaches the SDK with the holder title and conflict details intact", async () => {
    await withTestHarness(async (harness) => {
      const title = "Masaq'  |\tmk\u3000channel";
      const { first, second } = seedTwoThreads(harness, title);
      const sdk = createBbSdk({
        transport: createHttpTransport({
          baseUrl: "http://localhost",
          runtime: "node",
          fetch: async (input, init) =>
            harness.app.fetch(new Request(input, init)),
        }),
      });
      const claimed = await sdk.experimental_threadRoles.claim({
        role: "channel",
        threadId: first.id,
      });
      expect(claimed.title).toBe(title);

      await expect(
        sdk.experimental_threadRoles.claim({
          role: "channel",
          threadId: second.id,
        }),
      ).rejects.toMatchObject({
        name: "BbHttpError",
        status: 409,
        code: "role_held",
        body: {
          details: { current: { threadId: first.id, title, generation: 1 } },
        },
      });
      await expect(
        sdk.experimental_threadRoles.get({ role: "channel" }),
      ).resolves.toEqual(claimed);
    });
  });
});
