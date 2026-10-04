import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { setAppSettings } from "@bb/db";
import {
  defaultAppSettings,
  encodeClientTurnRequestIdNumber,
  threadScope,
  turnScope,
} from "@bb/domain";
import { readJson } from "../helpers/json.js";
import {
  seedEvent,
  seedThreadFixture,
  seedTurnStarted,
} from "../helpers/seed.js";
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

describe("round 4 public event regressions", () => {
  const secret = "synthetic-review-token-1234";
  const authored = [
    "Explain",
    "Authorization:",
    "Bearer",
    "PLACEHOLDER_CREDENTIAL_EXAMPLE",
  ].join(" ");
  const env = Object.fromEntries(
    Array.from({ length: 256 }, (_, i) => [
      `SECRET_${i}`,
      `synthetic-decoy-${String(i).padStart(4, "0")}-${"x".repeat(30)}`,
    ]),
  ) as Record<string, string>;
  env.API_KEY = secret;
  const cases = [
    {
      name: "257-secret overflow echo",
      type: "item/completed",
      data: {
        item: {
          type: "toolCall",
          id: "synthetic-tool",
          tool: "probe",
          status: "completed",
          result: { env, echo: secret },
        },
      },
    },
    {
      name: "rejected-turn diagnostic",
      type: "client/turn/rejected",
      data: {
        requestId: encodeClientTurnRequestIdNumber({ value: 501 }),
        reason: "launch_failed",
        message: `Authorization: Bearer ${secret}`,
      },
    },
    {
      name: "escaped quoted cookie",
      type: "provider/warning",
      data: {
        category: "config",
        details: `raw {"header":"Cookie: sid=\\"${secret}\\"; other=2"}`,
      },
    },
    {
      name: "unterminated quoted cookie",
      type: "provider/warning",
      data: { category: "config", details: `Cookie: sid="${secret}` },
    },
    {
      name: "authored completed user message",
      type: "item/completed",
      data: {
        item: {
          type: "userMessage",
          id: "synthetic-message",
          content: [{ type: "text", text: authored }],
        },
      },
    },
  ];
  for (const mode of ["insert", "legacy-read"]) {
    for (const c of cases) {
      it(`${mode}: ${c.name}`, async () => {
        await withTestHarness({ isDevelopment: true }, async (harness) => {
          const { thread } = seedThreadFixture(harness);
          setAppSettings(harness.db, {
            ...defaultAppSettings,
            showDiagnosticEvents: true,
          });
          seedTurnStarted(harness.deps, {
            threadId: thread.id,
            turnId: "synthetic-turn",
            sequence: 1,
          });
          seedEvent(harness.deps, {
            threadId: thread.id,
            providerThreadId: "synthetic-provider",
            scope: c.type.startsWith("item/")
              ? turnScope("synthetic-turn")
              : threadScope(),
            sequence: 2,
            type: c.type,
            data: c.data,
          } as never);
          if (mode === "legacy-read") {
            harness.db.run(
              sql`UPDATE events SET data = ${JSON.stringify(c.data)} WHERE thread_id = ${thread.id} AND sequence = 2`,
            );
          }
          const res = await harness.app.request(
            `/api/v1/threads/${thread.id}/events`,
          );
          expect(res.status).toBe(200);
          const body = await res.text();
          if (c.name.startsWith("authored")) {
            expect(body).toContain(authored);
          } else {
            expect(body).not.toContain(secret);
          }
        });
      });
    }
  }
});

describe("round 5 public event regressions", () => {
  const secret = "synthetic-review-token-1234";
  const token = `${secret}bbbbbbbbsynthetic-middle-ccccccccsynthetic-tail`;
  const presentation = {
    label: { pending: "Working", completed: "Done" },
    icon: { glyph: "x" },
  };
  const detail = `abcdefgh${"x".repeat(272)}`;
  const cases = [
    {
      name: "client turn start params",
      type: "client/turn/start",
      data: {
        direction: "outbound",
        source: "tell",
        initiator: "user",
        request: {
          method: "turn/start",
          params: {
            authorization: `Bearer ${secret}`,
            input: [{ type: "text", text: "safe authored prompt" }],
          },
        },
      },
      keep: "safe authored prompt",
    },
    {
      name: "overlapping matcher prefix",
      type: "item/completed",
      data: {
        item: {
          type: "toolCall",
          id: "synthetic-tool",
          tool: "probe",
          status: "completed",
          result: {
            env: {
              API_KEY: token,
              SECRET_A: "aaaaaaaa",
              SECRET_B: "bbbbbbbb",
              SECRET_C: "cccccccc",
            },
            echo: `aaaaaaaa${token}`,
          },
        },
      },
    },
    {
      name: "free-form extension payload kind",
      type: "thread/extensionState/updated",
      data: {
        kind: "synthetic/state",
        payload: { env: { API_KEY: secret }, kind: secret },
      },
    },
    {
      name: "free-form operation status",
      type: "system/operation",
      data: {
        operation: "probe",
        operationId: "synthetic-operation",
        status: secret,
        message: "safe",
        metadata: { env: { API_KEY: secret } },
      },
    },
    {
      name: "cookie marker prefix",
      type: "provider/warning",
      data: { category: "config", details: `Cookie: [redacted]; sid=${secret}` },
    },
    {
      name: "authorization escaped internal quotes",
      type: "provider/warning",
      data: {
        category: "config",
        details: `Authorization: Digest username="a\\"b\\"c", response="${secret}"`,
      },
    },
    {
      name: "bounded presentation detail",
      type: "item/completed",
      data: {
        item: {
          type: "toolCall",
          id: "synthetic-tool",
          tool: "probe",
          status: "completed",
          result: { env: { API_KEY: "abcdefgh" } },
          presentation: { ...presentation, detail },
        },
      },
      seed: {
        item: {
          type: "toolCall",
          id: "synthetic-tool",
          tool: "probe",
          status: "completed",
          result: { env: { API_KEY: "abcdefgh" } },
          presentation: { ...presentation, detail: "safe" },
        },
      },
      forbid: "abcdefgh",
    },
  ] as Array<{
    name: string;
    type: string;
    data: unknown;
    seed?: unknown;
    keep?: string;
    forbid?: string;
  }>;
  for (const mode of ["insert", "legacy-read"]) {
    for (const c of cases) {
      it(`${mode}: ${c.name}`, async () => {
        await withTestHarness({ isDevelopment: true }, async (harness) => {
          const { thread } = seedThreadFixture(harness);
          setAppSettings(harness.db, {
            ...defaultAppSettings,
            showDiagnosticEvents: true,
          });
          seedTurnStarted(harness.deps, {
            threadId: thread.id,
            turnId: "synthetic-turn",
            sequence: 1,
          });
          seedEvent(harness.deps, {
            threadId: thread.id,
            providerThreadId: "synthetic-provider",
            scope: c.type.startsWith("item/")
              ? turnScope("synthetic-turn")
              : threadScope(),
            sequence: 2,
            type: c.type,
            data: mode === "legacy-read" && c.seed ? c.seed : c.data,
          } as never);
          if (mode === "legacy-read") {
            harness.db.run(
              sql`UPDATE events SET data = ${JSON.stringify(c.data)} WHERE thread_id = ${thread.id} AND sequence = 2`,
            );
          }
          const res = await harness.app.request(
            `/api/v1/threads/${thread.id}/events`,
          );
          expect(res.status).toBe(200);
          const body = await res.text();
          expect(body).not.toContain(c.forbid ?? secret);
          if (c.keep) {
            expect(body).toContain(c.keep);
          }
          if (c.name.includes("overlapping")) {
            expect(body).not.toContain("synthetic-middle");
            expect(body).not.toContain("synthetic-tail");
          }
        });
      });
    }
  }
});

describe("round 6 public event regressions", () => {
  const secret = "synthetic-review-token-1234";
  const tail = "synthetic-tail-credential-1234";
  const task = {
    type: "backgroundTask",
    id: "synthetic-task",
    taskType: "local_agent",
    description: "synthetic",
    status: "failed",
    taskStatus: "failed",
    skipTranscript: false,
  };
  const interaction = (description: unknown) => ({
    interaction: {
      id: "synthetic-i",
      status: "resolved",
      statusReason: null,
      origin: {
        kind: "plugin",
        pluginId: "synthetic-p",
        rendererId: "synthetic-r",
      },
      payload: { kind: "plugin", title: "Synthetic" },
      resolution: { kind: "plugin_submitted", description },
    },
  });
  const cases = [
    ...[
      "Cookie",
      "Set-Cookie",
      "Authorization",
      "Proxy-Authorization",
      "X-Api-Key",
      "X-Auth-Token",
      "X-Access-Token",
    ].map((name) => ({
      name: `unquoted escaped ${name}`,
      type: "provider/warning",
      data: { category: "config", details: `${name}: prefix\\"${tail}` },
      forbid: tail,
    })),
    {
      name: "closed quote before an escaped-quote header",
      type: "provider/warning",
      data: {
        category: "config",
        details: `earlier \\"ok\\"; Cookie: prefix\\"${tail}`,
      },
      forbid: tail,
    },
    {
      name: "image url with an apostrophe in the credential",
      type: "item/completed",
      data: {
        item: {
          type: "userMessage",
          id: "synthetic-message",
          content: [
            {
              type: "image",
              url: `https://example.invalid/img?token=prefix'${tail}&ok=1`,
            },
          ],
        },
      },
      forbid: tail,
    },
    {
      name: "scheme-less signed image url",
      type: "item/completed",
      data: {
        item: {
          type: "userMessage",
          id: "synthetic-message",
          content: [
            { type: "image", url: "//example.invalid/img?sig=synthtail-123456789xyz" },
          ],
        },
      },
      forbid: "synthtail-123456789xyz",
    },
    {
      name: "nested request params image url",
      type: "client/turn/start",
      data: {
        direction: "outbound",
        source: "tell",
        initiator: "user",
        request: {
          method: "turn/start",
          params: {
            inputGroups: [
              [{ type: "image", url: `https://example.invalid/i?%74oken=${tail}` }],
            ],
          },
        },
      },
      forbid: tail,
    },
    {
      name: "wrapped image query token",
      type: "item/completed",
      data: {
        item: {
          type: "userMessage",
          id: "synthetic-message",
          content: [
            { type: "image", url: `https://example.invalid/img?token=${secret}` },
          ],
        },
      },
    },
    ...["item/backgroundTask/progress", "item/backgroundTask/completed"].map(
      (type) => ({
        name: `${type} diagnostic error`,
        type,
        data: { item: { ...task, error: `launch failed api_key=${secret}` } },
      }),
    ),
    {
      name: "workflow agent error",
      type: "item/backgroundTask/progress",
      data: {
        item: {
          ...task,
          workflow: {
            phases: [],
            agents: [
              {
                index: 1,
                label: "synthetic",
                state: "failed",
                model: "synthetic",
                attempt: 1,
                cached: false,
                lastProgressAt: 1,
                error: `agent died: api_key=${secret}`,
              },
            ],
          },
        },
      },
    },
    {
      name: "question prose echo",
      type: "system/userQuestion/lifecycle",
      data: {
        interactionId: "synthetic-i",
        providerId: "synthetic-p",
        providerRequestId: "synthetic-r",
        status: "resolved",
        statusReason: null,
        resolution: {
          kind: "user_answer",
          answers: { authorization: { selected: [secret], freeText: secret } },
        },
        payload: {
          kind: "user_question",
          questions: [
            {
              id: "authorization",
              prompt: secret,
              shortLabel: secret,
              multiSelect: false,
              allowFreeText: true,
            },
          ],
        },
      },
    },
    {
      name: "payload size constraint after redaction",
      type: "system/interaction/lifecycle",
      data: interaction({
        payload: {
          env: { API_KEY: "abcdefgh" },
          echo: "abcdefgh".repeat(8000),
        },
      }),
      seed: interaction({
        payload: { env: { API_KEY: "abcdefgh" }, echo: "safe" },
      }),
      forbid: "abcdefgh",
    },
  ] as Array<{
    name: string;
    type: string;
    data: unknown;
    seed?: unknown;
    forbid?: string;
  }>;
  for (const mode of ["insert", "legacy-read"]) {
    for (const c of cases) {
      it(`${mode}: ${c.name}`, async () => {
        await withTestHarness({ isDevelopment: true }, async (harness) => {
          const { thread } = seedThreadFixture(harness);
          setAppSettings(harness.db, {
            ...defaultAppSettings,
            showDiagnosticEvents: true,
          });
          seedTurnStarted(harness.deps, {
            threadId: thread.id,
            turnId: "synthetic-turn",
            sequence: 1,
          });
          seedEvent(harness.deps, {
            threadId: thread.id,
            providerThreadId: "synthetic-provider",
            scope:
              c.type === "item/completed" || c.type.startsWith("system/")
                ? turnScope("synthetic-turn")
                : threadScope(),
            sequence: 2,
            type: c.type,
            data: mode === "legacy-read" && c.seed ? c.seed : c.data,
          } as never);
          if (mode === "legacy-read") {
            harness.db.run(
              sql`UPDATE events SET data = ${JSON.stringify(c.data)} WHERE thread_id = ${thread.id} AND sequence = 2`,
            );
          }
          const res = await harness.app.request(
            `/api/v1/threads/${thread.id}/events`,
          );
          expect(res.status).toBe(200);
          expect(await res.text()).not.toContain(c.forbid ?? secret);
        });
      });
    }
  }
});

describe("round 8 public event regressions", () => {
  const tail = "synthtail-123456789xyz";
  const cases: Array<{ name: string; type: string; data: unknown }> = [
    ...["Cookie", "Set-Cookie", "Authorization", "X-Api-Key"].flatMap((name) =>
      ['"', "'", '\\"', '\\\\"', '\\\\\\\\\\"'].map((q) => ({
        name: `${name} after x${q}!${q}`,
        type: "provider/warning",
        data: {
          category: "config",
          details: `x${q}!${q}; ${name}: prefix${q}${tail}`,
        },
      })),
    ),
    {
      name: "underscore and non-ASCII word characters",
      type: "provider/warning",
      data: {
        category: "config",
        details: `_"!" é'!'; Cookie: prefix"${tail}`,
      },
    },
    {
      name: "16 KB image url with a trailing escape",
      type: "item/completed",
      data: {
        item: {
          type: "userMessage",
          id: "synthetic-message",
          content: [
            {
              type: "image",
              url: `https://example.invalid/?${"a=1?".repeat(4000)}%20`,
            },
          ],
        },
      },
    },
  ];
  for (const mode of ["insert", "legacy-read"]) {
    for (const c of cases) {
      it(`${mode}: ${c.name}`, async () => {
        await withTestHarness({ isDevelopment: true }, async (harness) => {
          const { thread } = seedThreadFixture(harness);
          setAppSettings(harness.db, {
            ...defaultAppSettings,
            showDiagnosticEvents: true,
          });
          seedTurnStarted(harness.deps, {
            threadId: thread.id,
            turnId: "synthetic-turn",
            sequence: 1,
          });
          seedEvent(harness.deps, {
            threadId: thread.id,
            providerThreadId: "synthetic-provider",
            scope:
              c.type === "item/completed"
                ? turnScope("synthetic-turn")
                : threadScope(),
            sequence: 2,
            type: c.type,
            data: c.data,
          } as never);
          if (mode === "legacy-read") {
            harness.db.run(
              sql`UPDATE events SET data = ${JSON.stringify(c.data)} WHERE thread_id = ${thread.id} AND sequence = 2`,
            );
          }
          const start = performance.now();
          const res = await harness.app.request(
            `/api/v1/threads/${thread.id}/events`,
          );
          const body = await res.text();
          expect(res.status).toBe(200);
          expect(body).not.toContain(tail);
          expect(performance.now() - start).toBeLessThan(3000);
        });
      });
    }
  }
});
