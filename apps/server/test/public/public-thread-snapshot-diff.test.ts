import { expect, it } from "vitest";
import { turnSnapshotDiffSchema } from "@bb/server-contract";
import { seedThreadFixture } from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";

it("returns a disabled interval result and refuses an unknown thread", async () => {
  await withTestHarness(async (harness) => {
    const { thread } = seedThreadFixture(harness);
    const response = await harness.app.request(
      `/api/v1/threads/${thread.id}/turns/turn/snapshot-diff`,
    );
    expect(response.status).toBe(200);
    expect(turnSnapshotDiffSchema.parse(await response.json())).toMatchObject({
      status: "not-captured",
      reason: "turn snapshot diff is disabled",
      names: [],
      patch: "",
    });
    const missing = await harness.app.request(
      "/api/v1/threads/missing/turns/turn/snapshot-diff",
    );
    expect(missing.status).toBe(404);
  });
});
