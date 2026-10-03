import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { setAppSettings } from "@bb/db";
import { defaultAppSettings, threadScope } from "@bb/domain";
import { readJson } from "../helpers/json.js";
import { seedEvent, seedThreadFixture } from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";

const POOL_TOKEN = "synthetic-pool-token-0000";
const LEGACY_DATA = JSON.stringify({
  entries: [
    { name: "CODEX_POOL_AUTH_TOKEN", source: "shell", value: POOL_TOKEN },
    {
      name: "BB_ACCOUNT_POOL_PARENT_URL",
      source: "shell",
      value: `http://hub:${POOL_TOKEN}@127.0.0.1:9000`,
    },
    { name: "PATH", source: "shell", value: "/usr/bin" },
  ],
});

describe("provider.env-resolved is redacted on every read path", () => {
  it("redacts at record time, and for legacy plaintext rows on read", async () => {
    await withTestHarness({ isDevelopment: true }, async (harness) => {
      const { thread } = seedThreadFixture(harness);
      setAppSettings(harness.db, {
        ...defaultAppSettings,
        showDiagnosticEvents: true,
      });
      const seed = (sequence: number) =>
        seedEvent(harness.deps, {
          threadId: thread.id,
          providerThreadId: "provider-session",
          scope: threadScope(),
          sequence,
          type: "provider.env-resolved",
          data: JSON.parse(LEGACY_DATA),
        });
      seed(1);
      seed(2);

      const stored = harness.db.all<{ data: string }>(
        sql`SELECT data FROM events WHERE thread_id = ${thread.id}`,
      );
      for (const row of stored) {
        expect(row.data).not.toContain(POOL_TOKEN);
      }

      // Row 2 stands in for an event stored before the record-time fix.
      harness.db.run(
        sql`UPDATE events SET data = ${LEGACY_DATA} WHERE thread_id = ${thread.id} AND sequence = 2`,
      );

      const list = await harness.app.request(
        `/api/v1/threads/${thread.id}/events?types=provider.env-resolved`,
      );
      expect(list.status).toBe(200);
      const listText = JSON.stringify(await readJson(list));
      expect(listText).not.toContain(POOL_TOKEN);
      expect(listText).toContain("CODEX_POOL_AUTH_TOKEN");
      expect(listText).toContain("[redacted]");

      const wait = await harness.app.request(
        `/api/v1/threads/${thread.id}/events/wait?type=provider.env-resolved&afterSeq=1&waitMs=0`,
      );
      expect(wait.status).toBe(200);
      expect(JSON.stringify(await readJson(wait))).not.toContain(POOL_TOKEN);

      const timeline = await harness.app.request(
        `/api/v1/threads/${thread.id}/timeline`,
      );
      expect(timeline.status).toBe(200);
      expect(JSON.stringify(await readJson(timeline))).not.toContain(
        POOL_TOKEN,
      );
    });
  });
});
