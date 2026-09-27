import {
  apiErrorSchema,
  recordThreadSearchSelectionResponseSchema,
  threadSearchLearnedBoostResponseSchema,
} from "@bb/server-contract";
import { describe, expect, it } from "vitest";
import { readJson } from "../helpers/json.js";
import {
  seedHostSession,
  seedProjectWithSource,
  seedThread,
} from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";

describe("public thread search learned boost routes", () => {
  it("returns null when no selection has been recorded for the query", async () => {
    await withTestHarness(async (harness) => {
      const response = await harness.app.request(
        "/api/v1/threads/search/learned-boost?query=af",
      );
      expect(response.status).toBe(200);
      const body = threadSearchLearnedBoostResponseSchema.parse(
        await readJson(response),
      );
      expect(body.threadId).toBeNull();
    });
  });

  it("validates the query parameter", async () => {
    await withTestHarness(async (harness) => {
      const missingQueryResponse = await harness.app.request(
        "/api/v1/threads/search/learned-boost",
      );
      expect(missingQueryResponse.status).toBe(400);

      const shortQueryResponse = await harness.app.request(
        "/api/v1/threads/search/learned-boost?query=x",
      );
      expect(shortQueryResponse.status).toBe(400);
    });
  });

  it("records a selection and then surfaces it as the learned boost for a matching prefix", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
      });

      const recordResponse = await harness.app.request(
        "/api/v1/threads/search/selections",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            query: "afternoon-standup",
            threadId: thread.id,
          }),
        },
      );
      expect(recordResponse.status).toBe(200);
      expect(
        recordThreadSearchSelectionResponseSchema.parse(
          await readJson(recordResponse),
        ),
      ).toEqual({ ok: true });

      const boostResponse = await harness.app.request(
        "/api/v1/threads/search/learned-boost?query=af",
      );
      expect(boostResponse.status).toBe(200);
      const boostBody = threadSearchLearnedBoostResponseSchema.parse(
        await readJson(boostResponse),
      );
      expect(boostBody.threadId).toBe(thread.id);
    });
  });

  it("rejects recording a selection for a query that is too short or a missing thread", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
      });

      const shortQueryResponse = await harness.app.request(
        "/api/v1/threads/search/selections",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ query: "x", threadId: thread.id }),
        },
      );
      expect(shortQueryResponse.status).toBe(400);

      const missingThreadResponse = await harness.app.request(
        "/api/v1/threads/search/selections",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ query: "afternoon", threadId: "thr_missing" }),
        },
      );
      expect(missingThreadResponse.status).toBe(404);
      expect(
        apiErrorSchema.parse(await readJson(missingThreadResponse)),
      ).toMatchObject({
        code: "thread_not_found",
      });
    });
  });
});
