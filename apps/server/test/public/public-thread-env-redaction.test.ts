import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { setAppSettings } from "@bb/db";
import { defaultAppSettings, threadScope, turnScope } from "@bb/domain";
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

describe("other event types are redacted on every read path", () => {
  const SECRET = "synthetic-review-token-1234";
  const legacyRows: Array<[string, Record<string, unknown>]> = [
    [
      "provider/warning",
      {
        category: "config",
        summary: "x",
        details: `Authorization: Bearer ${SECRET}`,
      },
    ],
    ["provider/error", { message: `failed --api-key ${SECRET}` }],
    [
      "client/thread/start",
      {
        direction: "outbound",
        source: "spawn",
        initiator: "user",
        request: {
          method: "thread/start",
          params: {
            options: { envVars: { CODEX_POOL_AUTH_TOKEN: SECRET } },
          },
        },
      },
    ],
    [
      "provider/unhandled",
      {
        providerId: "fake",
        rawType: "x",
        rawEvent: {
          jsonrpc: "2.0",
          method: "x",
          params: { env: { SOME_SECRET: SECRET } },
        },
      },
    ],
  ];

  it("redacts legacy plaintext rows of warning/error/start/unhandled events", async () => {
    await withTestHarness({ isDevelopment: true }, async (harness) => {
      const { thread } = seedThreadFixture(harness);
      setAppSettings(harness.db, {
        ...defaultAppSettings,
        showDiagnosticEvents: true,
      });
      legacyRows.forEach(([type, data], index) => {
        seedEvent(harness.deps, {
          threadId: thread.id,
          providerThreadId: "provider-session",
          scope: threadScope(),
          sequence: index + 1,
          type,
          data: { ...data },
        } as never);
        harness.db.run(
          sql`UPDATE events SET data = ${JSON.stringify(data)} WHERE thread_id = ${thread.id} AND sequence = ${index + 1}`,
        );
      });

      for (const path of [
        `events`,
        `events?afterSeq=1&beforeSeq=5&limit=3&order=desc`,
        ...legacyRows.map(
          ([type]) =>
            `events/wait?type=${encodeURIComponent(type)}&afterSeq=0&waitMs=0`,
        ),
        `timeline`,
      ]) {
        const res = await harness.app.request(
          `/api/v1/threads/${thread.id}/${path}`,
        );
        expect(res.status, path).toBe(200);
        expect(JSON.stringify(await readJson(res)), path).not.toContain(SECRET);
      }
    });
  });
});

describe("round-3 redaction policy on every read path", () => {
  const SECRET = "synthetic-review-token-1234";
  const PROMPT = 'run tool --api-key PLACEHOLDER with {"author":"Ada"}';
  const STRUCTURED = {
    token: { kind: "keyword", text: "function" },
    auth: { status: "public" },
    author: "Ada",
  };
  const rows: Array<[string, Record<string, unknown>]> = [
    [
      "provider/warning",
      {
        category: "config",
        summary: "x",
        details: `curl -H 'Cookie: "sid=${SECRET}; other=1"' next`,
      },
    ],
    [
      "item/completed",
      {
        item: {
          id: "i1",
          type: "toolCall",
          tool: "probe",
          status: "completed",
          result: {
            env: [{ name: "API_KEY", value: SECRET }],
            headers: [["Authorization", `Bearer ${SECRET}`]],
            text: `Set-Cookie: "sid=${SECRET}"`,
            structured: STRUCTURED,
          },
        },
      },
    ],
  ];

  it("redacts secrets and keeps ordinary content on list/wait/timeline", async () => {
    await withTestHarness({ isDevelopment: true }, async (harness) => {
      const { thread } = seedThreadFixture(harness);
      setAppSettings(harness.db, {
        ...defaultAppSettings,
        showDiagnosticEvents: true,
      });
      rows.forEach(([type, data], index) => {
        seedEvent(harness.deps, {
          threadId: thread.id,
          providerThreadId: "provider-session",
          scope: type.startsWith("item/")
            ? turnScope("synthetic-turn")
            : threadScope(),
          sequence: index + 1,
          type,
          data: { ...data },
        } as never);
        harness.db.run(
          sql`UPDATE events SET data = ${JSON.stringify(data)} WHERE thread_id = ${thread.id} AND sequence = ${index + 1}`,
        );
      });
      for (const path of ["events", "timeline"]) {
        const res = await harness.app.request(
          `/api/v1/threads/${thread.id}/${path}`,
        );
        expect(res.status, path).toBe(200);
        const text = JSON.stringify(await readJson(res));
        expect(text, path).not.toContain(SECRET);
      }
      const res = await harness.app.request(
        `/api/v1/threads/${thread.id}/events?types=item/completed`,
      );
      const text = JSON.stringify(await readJson(res));
      expect(text).toContain("function");
      expect(text).toContain("Ada");
      expect(PROMPT).toContain("PLACEHOLDER");
    });
  });
});
