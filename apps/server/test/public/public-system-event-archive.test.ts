import { describe, expect, it } from "vitest";
import { readJson } from "../helpers/json.js";
import { withTestHarness } from "../helpers/test-app.js";

const API = "/api/v1/system/event-archive";
const MACHINE_HEADERS = { "x-bb-gate-auth": "machine" };

function postJson(body: unknown, headers: Record<string, string> = {}) {
  return {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", ...headers },
    method: "POST",
  };
}

describe("/api/v1/system/event-archive", () => {
  it("reports an empty archive with the tier off by default", () =>
    withTestHarness(async (harness) => {
      const response = await harness.app.request(API);

      expect(response.status).toBe(200);
      const status = await readJson(response);
      expect(status).toMatchObject({
        coldThreads: 0,
        config: { mode: "off" },
        inconsistencies: [],
        missingLiveSegments: [],
        queueDepth: 0,
      });
      expect(
        Object.values(
          (status as { classes: Record<string, { count: number }> }).classes,
        ).every((totals) => totals.count === 0),
      ).toBe(true);
    }));

  it("rehydrates every cold thread and reconciles an empty archive", () =>
    withTestHarness(async (harness) => {
      const all = await harness.app.request(
        `${API}/rehydrate`,
        postJson({ all: true }),
      );
      expect(all.status).toBe(200);
      expect(await readJson(all)).toEqual({
        failed: [],
        rehydrated: 0,
        scope: "all",
      });

      const reconcile = await harness.app.request(`${API}/reconcile`, {
        method: "POST",
      });
      expect(reconcile.status).toBe(200);
      expect(await readJson(reconcile)).toMatchObject({
        orphaned: [],
        repairedCommitted: [],
      });
    }));

  it("rejects an unknown thread and a request naming both a thread and all", () =>
    withTestHarness(async (harness) => {
      const unknown = await harness.app.request(
        `${API}/rehydrate`,
        postJson({ threadId: "thr_missing" }),
      );
      expect(unknown.status).toBe(404);
      expect(await readJson(unknown)).toMatchObject({
        code: "thread_not_found",
      });

      const both = await harness.app.request(
        `${API}/rehydrate`,
        postJson({ all: true, threadId: "thr_missing" }),
      );
      expect(both.status).toBe(400);
    }));

  it("refuses machine credentials", () =>
    withTestHarness(async (harness) => {
      const responses = await Promise.all([
        harness.app.request(API, { headers: MACHINE_HEADERS }),
        harness.app.request(
          `${API}/rehydrate`,
          postJson({ all: true }, MACHINE_HEADERS),
        ),
        harness.app.request(`${API}/reconcile`, {
          headers: MACHINE_HEADERS,
          method: "POST",
        }),
      ]);
      expect(responses.map((response) => response.status)).toEqual([
        403, 403, 403,
      ]);
    }));
});
