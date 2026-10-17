import { describe, expect, it } from "vitest";
import {
  redactEventDataForType,
  redactThreadEventPayload,
  threadEventSchema,
  threadScope,
  turnScope,
} from "../src/index.js";
import { sanitizeCredentialsDeep } from "../src/provider-env-redaction.js";

const SECRET = "synthetic-review-token-1234";
const TAIL = "synthetic-tail-credential-1234";

function envelope(type: string, data: Record<string, unknown>) {
  return {
    type,
    threadId: "thr_synthetic",
    providerThreadId: "synthetic-provider",
    ...data,
  };
}

/** Redacts a full event; always schema-valid and idempotent afterwards. */
function sanitize(type: string, data: Record<string, unknown>) {
  let event: unknown;
  for (const scope of [turnScope("synthetic-turn"), threadScope()]) {
    const candidate = { ...envelope(type, data), scope };
    if (threadEventSchema.safeParse(candidate).success) {
      event = candidate;
      break;
    }
  }
  expect(event, `${type} fixture must be valid`).toBeDefined();
  const out = redactThreadEventPayload(event as { type: string });
  expect(threadEventSchema.safeParse(out).success).toBe(true);
  expect(redactThreadEventPayload(out)).toEqual(out);
  return out as Record<string, unknown>;
}

const HEADERS = [
  "Cookie",
  "Set-Cookie",
  "Authorization",
  "Proxy-Authorization",
  "X-Api-Key",
  "X-Auth-Token",
  "X-Access-Token",
];

describe("round 6: unquoted header value with an escaped quote", () => {
  for (const name of HEADERS) {
    it(`${name}: no suffix survives`, () => {
      const out = redactEventDataForType("provider/warning", {
        category: "config",
        details: `${name}: prefix\\"${TAIL}`,
      }) as { details: string };
      expect(out.details).not.toContain(TAIL);
      expect(out.details.startsWith(`${name}: [redacted]`)).toBe(true);
    });
  }

  it("covers unterminated, plain-quote and serialization-depth variants", () => {
    for (const text of [
      `Cookie: prefix\\"${TAIL}`,
      `Cookie: prefix\\\\\\"${TAIL}`,
      `Cookie: prefix"${TAIL}`,
      `Cookie: prefix'${TAIL}`,
      `Cookie: a=b; c=\\"d\\"${TAIL}`,
      `{\\"h\\":\\"Cookie: prefix\\\\\\"${TAIL}\\"}`,
    ]) {
      const out = redactEventDataForType("provider/warning", {
        category: "config",
        details: text,
      }) as { details: string };
      expect(out.details, text).not.toContain(TAIL);
      expect(redactEventDataForType("provider/warning", out)).toEqual(out);
    }
  });

  it("still keeps text after the surrounding quote closes", () => {
    for (const [text, rest] of [
      [`curl -H 'Cookie: sid=${TAIL}' next`, "next"],
      [`say "Authorization: Bearer ${TAIL}" next`, "next"],
      [`{\\"m\\":\\"X-Api-Key: ${TAIL}\\",\\"other\\":1}`, "other"],
    ] as const) {
      const out = redactEventDataForType("provider/warning", {
        category: "config",
        details: text,
      }) as { details: string };
      expect(out.details, text).not.toContain(TAIL);
      expect(out.details, text).toContain(rest);
    }
  });

  it("scales linearly", () => {
    const run = (n: number) => {
      const text = `Cookie: a\\"b `.repeat(n);
      const start = performance.now();
      redactEventDataForType("provider/warning", {
        category: "config",
        details: text,
      });
      return performance.now() - start;
    };
    run(2000);
    const small = Math.max(run(20000), 1);
    const large = run(80000);
    expect(large / small).toBeLessThan(12);
  });
});

describe("round 6: URL fields scrub credential parameters", () => {
  it("wrapped userMessage image url", () => {
    const out = sanitize("item/completed", {
      item: {
        type: "userMessage",
        id: "synthetic-message",
        content: [
          { type: "image", url: `https://example.invalid/img?token=${SECRET}&a=1` },
          { type: "text", text: `token=${SECRET}-prompt` },
        ],
      },
    }) as { item: { content: { url?: string; text?: string }[] } };
    const url = out.item.content[0]?.url ?? "";
    expect(url).not.toContain(SECRET);
    expect(url).toContain("a=1");
    expect(() => new URL(url)).not.toThrow();
    // Authored prompt text stays untouched.
    expect(out.item.content[1]?.text).toContain(SECRET);
  });

  const requested = (image: unknown, params: unknown) => ({
    direction: "outbound",
    requestId: "creq_23456789ab",
    source: "tell",
    initiator: "user",
    senderThreadId: null,
    input: [image],
    inputGroups: [[image]],
    target: { kind: "new-turn" },
    request: { method: "turn/start", params },
    execution: {
      model: "gpt-5",
      serviceTier: "default",
      reasoningLevel: "medium",
      permissionMode: "full",
      source: "client/turn/requested",
    },
  });

  it("client/turn/requested input, inputGroups and params image urls", () => {
    const image = {
      type: "image",
      url: `https://example.invalid/i.png?X-Amz-Signature=${SECRET}&sig=${SECRET}&ok=1`,
    };
    const out = sanitize(
      "client/turn/requested",
      requested(image, { input: [image] }),
    ) as { input: { url: string }[]; inputGroups: { url: string }[][] };
    expect(JSON.stringify(out)).not.toContain(SECRET);
    expect(out.input[0]?.url).toContain("ok=1");
    expect(out.inputGroups[0]?.[0]?.url).toContain("ok=1");
  });

  it("client/turn/start params image url", () => {
    const out = redactEventDataForType("client/turn/start", {
      direction: "outbound",
      source: "tell",
      initiator: "user",
      request: {
        method: "turn/start",
        params: {
          input: [
            { type: "image", url: `https://example.invalid/i?token=${SECRET}&ok=1` },
          ],
        },
      },
    });
    expect(JSON.stringify(out)).not.toContain(SECRET);
    expect(JSON.stringify(out)).toContain("ok=1");
  });
});

describe("round 6: background-task diagnostics", () => {
  const base = {
    type: "backgroundTask",
    id: "synthetic-task",
    taskType: "local_agent",
    description: "synthetic",
    status: "failed",
    taskStatus: "failed",
    skipTranscript: false,
  };
  for (const type of [
    "item/backgroundTask/progress",
    "item/backgroundTask/completed",
  ]) {
    it(`${type}: item.error is diagnostic`, () => {
      const out = sanitize(type, {
        item: { ...base, error: `launch failed api_key=${SECRET}` },
      });
      expect(JSON.stringify(out)).not.toContain(SECRET);
    });

    it(`${type}: workflow agent error is diagnostic`, () => {
      const out = sanitize(type, {
        item: {
          ...base,
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
                error: `agent died: api_key=${SECRET}`,
              },
            ],
          },
        },
      });
      expect(JSON.stringify(out)).not.toContain(SECRET);
    });
  }
});

describe("round 6: custom-refined prose is redacted, identities kept", () => {
  it("userQuestion prompt and shortLabel echoes", () => {
    const out = sanitize("system/userQuestion/lifecycle", {
      interactionId: "synthetic-i",
      providerId: "synthetic-p",
      providerRequestId: "synthetic-r",
      status: "resolved",
      statusReason: null,
      resolution: {
        kind: "user_answer",
        answers: {
          authorization: { selected: [SECRET], freeText: SECRET },
        },
      },
      payload: {
        kind: "user_question",
        questions: [
          {
            id: "authorization",
            prompt: SECRET,
            shortLabel: SECRET,
            multiSelect: false,
            allowFreeText: true,
          },
        ],
      },
    }) as {
      interactionId: string;
      payload: { questions: { id: string }[] };
    };
    expect(JSON.stringify(out)).not.toContain(SECRET);
    expect(out.interactionId).toBe("synthetic-i");
    expect(out.payload.questions[0]?.id).toBe("authorization");
  });

  it("unique option values stay unique after redaction", () => {
    const out = sanitize("system/userQuestion/lifecycle", {
      interactionId: "synthetic-i",
      providerId: "synthetic-p",
      providerRequestId: "synthetic-r",
      status: "pending",
      statusReason: null,
      payload: {
        kind: "user_question",
        questions: [
          {
            id: "q1",
            prompt: "which",
            multiSelect: false,
            allowFreeText: false,
            options: [
              { value: `api_key=${SECRET}-a`, label: `api_key=${SECRET}-a` },
              { value: `api_key=${SECRET}-b`, label: `api_key=${SECRET}-b` },
              { value: "plain", label: "plain" },
            ],
          },
        ],
      },
      resolution: null,
    });
    expect(JSON.stringify(out)).not.toContain(SECRET);
    const values = (
      out as { payload: { questions: { options: { value: string }[] }[] } }
    ).payload.questions[0]!.options.map((option) => option.value);
    expect(new Set(values).size).toBe(values.length);
  });
});

describe("round 6: schema repair fails closed", () => {
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

  it("redaction that grows a container past its size limit is repaired", () => {
    const out = sanitize(
      "system/interaction/lifecycle",
      interaction({
        payload: {
          env: { API_KEY: "abcdefgh" },
          echo: "abcdefgh".repeat(8000),
        },
      }),
    );
    expect(JSON.stringify(out)).not.toContain("abcdefgh");
  });

  const validRequest = (url: string) => ({
    ...envelope("client/turn/requested", {}),
    scope: threadScope(),
    direction: "outbound",
    requestId: "creq_23456789ab",
    source: "tell",
    initiator: "user",
    senderThreadId: null,
    input: [{ type: "image", url }],
    target: { kind: "new-turn" },
    request: { method: "turn/start", params: {} },
    execution: {
      model: "gpt-5",
      serviceTier: "default",
      reasoningLevel: "medium",
      permissionMode: "full",
      source: "client/turn/requested",
    },
  });

  it("repair never restores original text", () => {
    const original = validRequest(`https://example.invalid/i?token=${SECRET}`);
    expect(threadEventSchema.safeParse(original).success).toBe(true);
    // A redaction step that leaves a non-URL where the schema wants a URL.
    const broken = validRequest("[redacted]");
    const out = sanitizeCredentialsDeep(broken, {
      freeText: false,
      structural: { type: "client/turn/requested", fullEvent: true },
      original,
    });
    expect(JSON.stringify(out)).not.toContain(SECRET);
    expect(threadEventSchema.safeParse(out).success).toBe(true);
  });

  it("compares against the raw original, not the already-redacted base", () => {
    const original = validRequest("https://example.invalid/ok.png");
    const base = validRequest("[redacted]");
    const out = sanitizeCredentialsDeep(base, {
      freeText: false,
      structural: { type: "client/turn/requested", fullEvent: true },
      original,
    }) as { input: { url: string }[] };
    expect(out).not.toBe(base);
    expect(threadEventSchema.safeParse(out).success).toBe(true);
  });
});
