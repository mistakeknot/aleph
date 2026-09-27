import { markThreadDeleted } from "@bb/db";
import {
  apiErrorSchema,
  recordThreadSearchSelectionResponseSchema,
  threadSearchResponseSchema,
} from "@bb/server-contract";
import { describe, expect, it } from "vitest";
import { readJson } from "../helpers/json.js";
import {
  seedHostSession,
  seedProjectWithSource,
  seedThread,
} from "../helpers/seed.js";
import { type TestAppHarness, withTestHarness } from "../helpers/test-app.js";

function recordSelection(
  harness: TestAppHarness,
  query: string,
  threadId: string,
) {
  return harness.app.request("/api/v1/threads/search/selections", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, threadId }),
  });
}

async function searchActiveThreadIds(harness: TestAppHarness, query: string) {
  const response = await harness.app.request(
    `/api/v1/threads/search?query=${encodeURIComponent(query)}&limitPerGroup=10`,
  );
  expect(response.status).toBe(200);
  const body = threadSearchResponseSchema.parse(await readJson(response));
  return body.active.results.map((result) => result.thread.id);
}

describe("public thread search learned selections", () => {
  it("leads search results with a thread picked repeatedly for a matching prefix", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const learnedThread = seedThread(harness.deps, {
        projectId: project.id,
        title: "learnroute beta",
        titleFallback: "learnroute beta",
      });
      const otherThread = seedThread(harness.deps, {
        projectId: project.id,
        title: "learnroute alpha",
        titleFallback: "learnroute alpha",
      });

      // A single pick is below the learning threshold and must not reorder.
      const firstRecord = await recordSelection(
        harness,
        "learnroute",
        learnedThread.id,
      );
      expect(firstRecord.status).toBe(200);
      expect(
        recordThreadSearchSelectionResponseSchema.parse(
          await readJson(firstRecord),
        ),
      ).toEqual({ ok: true });
      const beforeLearning = await searchActiveThreadIds(harness, "learnro");
      expect(beforeLearning).toEqual(
        expect.arrayContaining([learnedThread.id, otherThread.id]),
      );

      expect(
        (await recordSelection(harness, "learnroute", learnedThread.id)).status,
      ).toBe(200);
      const afterLearning = await searchActiveThreadIds(harness, "learnro");
      expect(afterLearning[0]).toBe(learnedThread.id);
      expect(afterLearning).toContain(otherThread.id);
    });
  });

  it("rejects a too-short query and missing, deleted or hidden threads", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const thread = seedThread(harness.deps, { projectId: project.id });
      const deletedThread = seedThread(harness.deps, {
        projectId: project.id,
      });
      markThreadDeleted(harness.deps.db, harness.deps.hub, {
        threadId: deletedThread.id,
      });
      const hiddenThread = seedThread(harness.deps, {
        projectId: project.id,
        visibility: "hidden",
      });

      expect((await recordSelection(harness, "x", thread.id)).status).toBe(400);

      for (const threadId of [
        "thr_missing",
        deletedThread.id,
        hiddenThread.id,
      ]) {
        const response = await recordSelection(harness, "afternoon", threadId);
        expect(response.status).toBe(404);
        expect(apiErrorSchema.parse(await readJson(response))).toMatchObject({
          code: "thread_not_found",
        });
      }
    });
  });
});
