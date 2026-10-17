import { describe, expect, it } from "vitest";
import {
  REDACTED_ENV_VALUE,
  parseStoredThreadEvent,
  redactEventDataForType,
  redactEventDataJsonForType,
  redactThreadEventPayload,
  threadEventSchema,
  threadScope,
  turnScope,
} from "../src/index.js";

const SECRET = "synthetic-review-token-1234";

function toolEvent(item: Record<string, unknown>) {
  return threadEventSchema.parse({
    type: "item/completed",
    threadId: "thr_synthetic",
    providerThreadId: "synthetic-provider",
    scope: turnScope("synthetic-turn"),
    item: {
      type: "toolCall",
      id: "synthetic-tool",
      tool: "probe",
      status: "completed",
      ...item,
    },
  });
}

describe("linear-time sanitizing", () => {
  const BOUND_MS = 500;

  function timed(fn: () => unknown): number {
    const start = performance.now();
    fn();
    return performance.now() - start;
  }

  const adversarialStrings: Array<[string, string]> = [
    ["repeated 'token '", "token ".repeat(64_000)],
    ["one long dotted secret-word", "token.".repeat(64_000)],
    ["one long word of secret words", "tokentoken".repeat(40_000)],
    ["dash run", "-".repeat(384_000)],
    ["flag-ish dash words", "--token".repeat(50_000)],
    ["backslash run", "\\".repeat(384_000)],
    ["escaped-quote runs", '\\"token\\":'.repeat(40_000)],
    ["many quotes", '"'.repeat(384_000)],
    ["many key openers", '"token":"'.repeat(40_000)],
    ["unterminated key openers", '"apiKey": "'.repeat(30_000)],
    ["assignment openers", "k=' k=\" ".repeat(50_000)],
    ["scheme-like run", "a.".repeat(190_000)],
    ["scheme openers", "a://".repeat(90_000)],
    ["cookie headers", 'Cookie: a="b'.repeat(30_000)],
    ["header spaces", `Cookie${" ".repeat(300_000)}`],
    ["bearer repeats", "Bearer ".repeat(50_000)],
    ["equals spaces", `k=${" ".repeat(300_000)}`],
  ];

  for (const [label, text] of adversarialStrings) {
    for (const type of [
      "provider/warning",
      "item/completed",
      "item/agentMessage/delta",
    ]) {
      it(`${type}: ${label} stays under the time bound (insert/read JSON path)`, () => {
        const json = JSON.stringify({ delta: text, message: text });
        const elapsed = timed(() => redactEventDataJsonForType(type, json));
        expect(elapsed).toBeLessThan(BOUND_MS);
      });
    }
  }

  it("is linear for random mixes of hostile fragments", () => {
    const fragments = [
      "token ",
      "a.",
      "-",
      "\\",
      '"',
      "'",
      "=",
      ":",
      " ",
      "Bearer ",
      "Cookie: ",
      "://",
      "key=",
      "--token ",
      '"token":',
      "\\u0061",
      "\n",
    ];
    let seed = 12345;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed;
    };
    for (let round = 0; round < 6; round += 1) {
      let text = "";
      while (text.length < 200_000) {
        text += fragments[rand() % fragments.length];
      }
      const elapsed = timed(() =>
        redactEventDataForType("provider/error", { message: text }),
      );
      expect(elapsed).toBeLessThan(BOUND_MS);
    }
  });

  it("handles deep and wide JSON within the bound", () => {
    const deepJson = `{"deep":${"[".repeat(20_000)}"${SECRET}"${"]".repeat(20_000)}}`;
    const wideJson = JSON.stringify({
      list: Array.from({ length: 300_000 }, (_, i) => ({ i, ok: true })),
    });
    for (const json of [deepJson, wideJson]) {
      for (const type of ["provider/unhandled", "item/completed"]) {
        expect(
          timed(() => redactEventDataJsonForType(type, json)),
        ).toBeLessThan(1500);
      }
    }
  });

  it("handles very many secret-named entries within the bound", () => {
    const env: Record<string, string> = {};
    for (let i = 0; i < 100_000; i += 1)
      env[`API_KEY_${i}`] = `secret-value-${i}-xx`;
    const out = redactEventDataForType("provider/unhandled", {
      env,
      text: "x".repeat(200_000),
    });
    expect(
      timed(() => redactEventDataForType("provider/unhandled", { env })),
    ).toBeLessThan(1500);
    expect(JSON.stringify(out)).not.toContain("secret-value-5-xx");
  });
});

describe("quoted cookie headers", () => {
  for (const header of ["Cookie", "Set-Cookie"]) {
    it(`redacts quoted ${header} values without eating following text`, () => {
      const out = redactEventDataForType("provider/warning", {
        details: `${header}: session="${SECRET}"; other=2`,
        after: "ok",
      });
      expect(JSON.stringify(out)).not.toContain(SECRET);
      expect(out.after).toBe("ok");
      expect(redactEventDataForType("provider/warning", out)).toEqual(out);
    });
  }

  it("keeps the surrounding shell quote after a quoted cookie", () => {
    const out = redactEventDataForType("provider/warning", {
      details: `curl -H 'Cookie: a="${SECRET}"' https://x.test`,
    });
    expect(JSON.stringify(out)).not.toContain(SECRET);
    expect(out.details).toContain("https://x.test");
  });
});

describe("tool result text", () => {
  it("scrubs Authorization/Cookie headers and bearer tokens in tool results", () => {
    const event = toolEvent({
      result: {
        content: [
          { type: "text", text: `Authorization: Bearer ${SECRET}` },
          { type: "text", text: `Cookie: session="${SECRET}"; x=1` },
          { type: "text", text: `fetch https://user:${SECRET}@host.test/x` },
          { type: "text", text: `token is Bearer ${SECRET}` },
        ],
      },
    });
    const out = redactEventDataForType(event.type, event);
    expect(JSON.stringify(out)).not.toContain(SECRET);
    for (const text of [`Authorization: Bearer ${SECRET}`]) {
      expect(
        redactEventDataJsonForType(
          "item/completed",
          JSON.stringify({ item: { result: text } }),
        ),
      ).not.toContain(SECRET);
    }
  });

  it("does not corrupt ordinary tool content", () => {
    const text = [
      "the token budget is exhausted; key: value",
      "const author = 'Ada'; const apiKey = process.env.X;",
      "Bearer tokens are described in RFC 6750",
      "design=ok sig=short --api-key PLACEHOLDER",
    ].join("\n");
    const event = toolEvent({ result: { content: [{ type: "text", text }] } });
    expect(redactEventDataForType(event.type, event)).toBe(event);
  });

  it("preserves structured tool results and schema-like tool arguments", () => {
    const event = toolEvent({
      arguments: { apiKey: "customer-schema-field", password: "field-name" },
      result: {
        token: { kind: "keyword", text: "function" },
        auth: { status: "public" },
        author: "Ada",
      },
    });
    expect(redactEventDataForType(event.type, event)).toBe(event);
  });
});

describe("authored user content", () => {
  it("keeps prompt text on client/turn/requested", () => {
    const data = {
      input: [
        {
          type: "text",
          text: 'Explain this example: --api-key PLACEHOLDER and {"author":"Ada"}',
        },
      ],
      clientRequestId: "creq_1",
    };
    expect(redactEventDataForType("client/turn/requested", data)).toBe(data);
    expect(redactEventDataForType("client/turn/start", data)).toBe(data);
  });

  it("does not treat `author` as a credential in diagnostics", () => {
    const out = redactEventDataForType("provider/warning", {
      message: 'saw {"author":"Ada","design":"x"} author: Ada design=y',
    });
    expect(out.message).toContain('"author":"Ada"');
    expect(out.message).toContain("author: Ada");
    expect(out.message).toContain("design=y");
  });

  it("still redacts real secret spellings in diagnostics", () => {
    for (const raw of [
      `{"auth":"${SECRET}"}`,
      `{"authToken":"${SECRET}"}`,
      `auth=${SECRET}`,
      `X-Auth: ${SECRET}`,
      `--sig ${SECRET}`,
      `{"api_key":"${SECRET}"}`,
    ]) {
      const out = redactEventDataForType("provider/error", { message: raw });
      expect(JSON.stringify(out), raw).not.toContain(SECRET);
    }
  });
});

describe("array-shaped credential containers", () => {
  it("redacts env name/value arrays and header tuples in tool results", () => {
    const event = toolEvent({
      result: {
        env: [
          { name: "API_KEY", value: SECRET },
          { name: "PATH", value: "/usr/bin" },
          { name: "NESTED_SECRET", value: { nested: [SECRET] } },
        ],
        headers: [
          ["Authorization", `Bearer ${SECRET}`],
          ["Accept", "json"],
        ],
        environment: [`MY_TOKEN=${SECRET}`, "HOME=/home/u"],
      },
    });
    const out = redactEventDataForType(event.type, event);
    const json = JSON.stringify(out);
    expect(json).not.toContain(SECRET);
    expect(json).toContain("/usr/bin");
    expect(json).toContain('"Accept","json"');
    expect(json).toContain("HOME=/home/u");
    expect(json).toContain("MY_TOKEN=[redacted]");
  });

  it("redacts the round-1 nested env-resolved entry shape", () => {
    const out = redactEventDataForType("provider.env-resolved", {
      entries: [
        { name: "API_KEY", source: "shell", value: { nested: [SECRET] } },
      ],
    });
    expect(JSON.stringify(out)).not.toContain(SECRET);
  });
});

describe("event envelope and limits", () => {
  it("never alters the envelope, even when payload limits trip", () => {
    const huge = Array.from({ length: 250_000 }, () => ({ ok: true }));
    let deep: unknown = SECRET;
    for (let i = 0; i < 200; i += 1) deep = { child: deep };
    for (const result of [huge, deep, { env: { API_KEY: SECRET } }]) {
      const event = toolEvent({ result });
      const out = redactThreadEventPayload(event);
      expect(out.scope).toEqual(event.scope);
      expect(out.threadId).toBe(event.threadId);
      expect((out as Record<string, unknown>).providerThreadId).toBe(
        (event as Record<string, unknown>).providerThreadId,
      );
      expect(threadEventSchema.safeParse(out).success).toBe(true);
      expect(JSON.stringify(out)).not.toContain(SECRET);
    }
  });

  it("keeps diagnostics schema-valid when the payload contains a secret echo of an envelope value", () => {
    const event = threadEventSchema.parse({
      type: "provider/warning",
      threadId: "thr_synthetic",
      providerThreadId: "synthetic-provider",
      scope: threadScope(),
      message: "w",
      category: "general",
      env: { API_TOKEN: "synthetic-provider" },
    });
    const out = redactThreadEventPayload(event);
    expect((out as Record<string, unknown>).providerThreadId).toBe(
      "synthetic-provider",
    );
    expect(threadEventSchema.safeParse(out).success).toBe(true);
  });

  it("decodes stored legacy rows after redaction", () => {
    const event = parseStoredThreadEvent({
      type: "item/completed",
      data: {
        item: {
          type: "toolCall",
          id: "t",
          tool: "p",
          status: "completed",
          result: { headers: [["Authorization", `Bearer ${SECRET}`]] },
        },
      },
      providerThreadId: "p",
      scope: turnScope("turn_1"),
      threadId: "thr_1",
    });
    expect(JSON.stringify(event)).not.toContain(SECRET);
    expect(JSON.stringify(event)).toContain(REDACTED_ENV_VALUE);
  });
});

describe("escaped keys in embedded diagnostic JSON", () => {
  it("redacts literal \\u-escaped keys inside diagnostic text", () => {
    const out = redactEventDataForType("provider/warning", {
      message: `raw: {"\\u0061piKey":"${SECRET}"}`,
    });
    expect(JSON.stringify(out)).not.toContain(SECRET);
  });
});

describe("header value that opens with a quote", () => {
  it('redacts `Cookie: "sid=...; other=1"` and keeps following text', () => {
    const text = `curl -H 'Cookie: "sid=${SECRET}; other=1"' next`;
    const out = redactEventDataForType("provider/warning", {
      type: "provider/warning",
      details: text,
    }) as { details: string };
    expect(out.details).not.toContain(SECRET);
    expect(out.details).toContain("next");
  });
});
