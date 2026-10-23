import { getThread, isThreadEventsCold } from "@bb/db";
import { describe, expect, it } from "vitest";
import { getThreadHistoryPinCount } from "../../src/services/threads/event-cold-tier/pins.js";
import {
  attemptColdMove,
  countThreadEvents,
  forceColdEligible,
  seedColdTierEvents,
} from "../helpers/cold-tier.js";
import { readJson } from "../helpers/json.js";
import { threadScope } from "@bb/domain";
import { seedEvent, seedThreadFixture } from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

let counter = 0;

async function seedColdCapable(harness: TestAppHarness) {
  counter += 1;
  const fixture = seedThreadFixture(harness, {
    session: { id: `host-cold-routes-${counter}` },
    environment: { path: `/tmp/cold-routes-${counter}` },
  });
  seedColdTierEvents(harness.db, fixture.thread.id);
  for (let sequence = 100; sequence < 104; sequence += 1)
    seedEvent(harness.deps, {
      data: { message: `error ${sequence}` },
      environmentId: fixture.environment.id,
      scope: threadScope(),
      sequence,
      threadId: fixture.thread.id,
      type: "system/error",
    });
  forceColdEligible(harness.db, {
    environmentId: fixture.environment.id,
    projectId: fixture.project.id,
    threadId: fixture.thread.id,
  });
  return fixture;
}

async function get(harness: TestAppHarness, url: string) {
  const response = await harness.app.request(url);
  return { status: response.status, body: await readJson(response) };
}

async function moveCold(harness: TestAppHarness, threadId: string) {
  const moved = await attemptColdMove(harness, threadId);
  expect(moved.outcome).toBe("moved");
  expect(isThreadEventsCold(harness.db, threadId)).toBe(true);
}

const READ_ROUTES = [
  ["timeline", "timeline"],
  ["events list", "events?limit=100&types=system%2Ferror"],
  ["context", "context"],
  ["conversation outline", "conversation-outline"],
] as const;

describe("cold thread read routes hydrate and match the hot result", () => {
  for (const [label, suffix] of READ_ROUTES) {
    it(`${label} returns the hot-equivalent body for a cold thread`, async () => {
      await withTestHarness(async (harness) => {
        const { thread } = await seedColdCapable(harness);
        const url = `/api/v1/threads/${thread.id}/${suffix}`;
        const hot = await get(harness, url);
        expect(hot).toMatchObject({ status: 200 });
        const hotRows = countThreadEvents(harness.db, thread.id);
        await moveCold(harness, thread.id);

        const cold = await get(harness, url);

        expect(cold.status).toBe(200);
        expect(cold.body).toEqual(hot.body);
        expect(isThreadEventsCold(harness.db, thread.id)).toBe(false);
        expect(countThreadEvents(harness.db, thread.id)).toBe(hotRows);
        expect(getThreadHistoryPinCount(thread.id)).toBe(0);
      });
    });
  }

  it("event wait on a cold thread hydrates and finds the matching event", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = await seedColdCapable(harness);
      await moveCold(harness, thread.id);

      const response = await get(
        harness,
        `/api/v1/threads/${thread.id}/events/wait?type=system%2Ferror&afterSeq=0&waitMs=200`,
      );

      expect(response.status).toBe(200);
      expect(isThreadEventsCold(harness.db, thread.id)).toBe(false);
      expect(getThreadHistoryPinCount(thread.id)).toBe(0);
    });
  });

  it("unarchive hydrates a cold thread before clearing archived_at", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = await seedColdCapable(harness);
      const hotRows = countThreadEvents(harness.db, thread.id);
      await moveCold(harness, thread.id);

      const response = await harness.app.request(
        `/api/v1/threads/${thread.id}/unarchive`,
        { method: "POST" },
      );

      expect(response.status).toBe(200);
      expect(isThreadEventsCold(harness.db, thread.id)).toBe(false);
      expect(countThreadEvents(harness.db, thread.id)).toBe(hotRows);
      expect(getThread(harness.db, thread.id)?.archivedAt).toBeNull();
      expect(getThreadHistoryPinCount(thread.id)).toBe(0);
    });
  });
});
