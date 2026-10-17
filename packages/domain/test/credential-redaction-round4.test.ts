import { describe, expect, it } from "vitest";
import {
  EVENT_TYPE_POLICIES,
  parseStoredThreadEvent,
  redactEventDataForType,
  redactEventDataJsonForType,
  redactThreadEventPayload,
  threadEventSchema,
  threadEventTypeValues,
  turnScope,
} from "../src/index.js";
import { listStructuralPaths } from "../src/thread-event-structure.js";

const SECRET = "synthetic-review-token-1234";
const PLACEHOLDER = [
  "Explain",
  "Authorization:",
  "Bearer",
  "PLACEHOLDER_CREDENTIAL_EXAMPLE",
].join(" ");

function itemEvent(type: string, item: Record<string, unknown>) {
  return threadEventSchema.parse({
    type,
    threadId: "thr_synthetic",
    providerThreadId: "synthetic-provider",
    scope: turnScope("synthetic-turn"),
    item,
  });
}

function toolEvent(result: Record<string, unknown>, extra = {}) {
  return itemEvent("item/completed", {
    type: "toolCall",
    id: "synthetic-tool",
    tool: "probe",
    status: "completed",
    result,
    ...extra,
  });
}

describe("round 4: secret count cap", () => {
  const env: Record<string, string> = Object.fromEntries(
    Array.from({ length: 256 }, (_, i) => [
      `SECRET_${i}`,
      `synthetic-decoy-${String(i).padStart(4, "0")}-${"x".repeat(30)}`,
    ]),
  );
  env.API_KEY = SECRET;
  const data = {
    item: {
      type: "toolCall",
      id: "synthetic-tool",
      tool: "probe",
      status: "completed",
      result: { env, echo: SECRET },
    },
  };

  it("redacts the echo after 256 decoys (domain)", () => {
    const out = JSON.stringify(redactEventDataForType("item/completed", data));
    expect(out).not.toContain(SECRET);
  });

  it("redacts at insert and on legacy read", () => {
    const json = redactEventDataJsonForType(
      "item/completed",
      JSON.stringify(data),
    );
    expect(json).not.toContain(SECRET);
    const parsed = parseStoredThreadEvent({
      type: "item/completed",
      threadId: "thr_synthetic",
      providerThreadId: "synthetic-provider",
      scope: turnScope("synthetic-turn"),
      data,
    });
    expect(JSON.stringify(parsed)).not.toContain(SECRET);
  });

  it("scales with many secrets", () => {
    const many: Record<string, string> = {};
    for (let i = 0; i < 5000; i++) {
      many[`SECRET_${i}`] = `synthetic-many-${i}-${"y".repeat(24)}`;
    }
    const start = performance.now();
    const out = JSON.stringify(
      redactEventDataForType("item/completed", {
        item: { ...data.item, result: { env: many, echo: many.SECRET_4999 } },
      }),
    );
    expect(performance.now() - start).toBeLessThan(2000);
    expect(out).not.toContain(many.SECRET_4999);
  });
});

describe("round 4: event policy table", () => {
  it("assigns every thread event type a policy", () => {
    for (const type of threadEventTypeValues) {
      expect(
        Object.prototype.hasOwnProperty.call(EVENT_TYPE_POLICIES, type),
        type,
      ).toBe(true);
    }
  });

  it("scrubs client/turn/rejected diagnostics", () => {
    const out = redactEventDataForType("client/turn/rejected", {
      requestId: "req",
      reason: `Authorization: Bearer ${SECRET}`,
      message: `Cookie: sid=${SECRET}`,
    });
    expect(JSON.stringify(out)).not.toContain(SECRET);
  });

  it("keeps authored prompt input", () => {
    const data = {
      input: [{ type: "text", text: PLACEHOLDER }],
    };
    const out = redactEventDataForType(
      "client/turn/requested",
      data,
    ) as typeof data;
    expect(out.input[0]?.text).toBe(PLACEHOLDER);
  });
});

describe("round 4: item policy by wrapped item type", () => {
  it.each([
    ["userMessage", { content: [{ type: "text", text: PLACEHOLDER }] }],
    ["agentMessage", { text: PLACEHOLDER }],
  ])("keeps authored text in completed %s", (type, rest) => {
    const event = itemEvent("item/completed", {
      type,
      id: "synthetic-message",
      ...rest,
    });
    const out = redactThreadEventPayload(event);
    expect(JSON.stringify(out)).toContain(PLACEHOLDER);
  });

  it("still scrubs tool results", () => {
    const out = redactThreadEventPayload(
      toolEvent({ output: `Authorization: Bearer ${SECRET}` }),
    );
    expect(JSON.stringify(out)).not.toContain(SECRET);
  });
});

describe("round 4: escaped and unterminated cookies", () => {
  const cases: Array<[string, string]> = [
    ["escaped", `raw {"header":"Cookie: sid=\\"${SECRET}\\"; other=2"}`],
    ["unterminated", `Cookie: sid="${SECRET}`],
    ["set-cookie unterminated", `Set-Cookie: sid="${SECRET}; Path=/`],
    ["set-cookie escaped", `{"h":"Set-Cookie: sid=\\"${SECRET}\\"; Path=/"}`],
  ];
  for (const [label, details] of cases) {
    it(label, () => {
      const out = JSON.stringify(
        redactEventDataForType("provider/warning", {
          category: "config",
          details,
        }),
      );
      expect(out).not.toContain(SECRET);
      const again = redactEventDataForType("provider/warning", JSON.parse(out));
      expect(JSON.stringify(again)).toBe(out);
    });
  }

  it("keeps text after a real delimiter", () => {
    const out = JSON.stringify(
      redactEventDataForType("provider/warning", {
        category: "config",
        details: `Cookie: sid="${SECRET}"\nnext line kept`,
      }),
    );
    expect(out).not.toContain(SECRET);
    expect(out).toContain("next line kept");
  });

  it("scales", () => {
    const start = performance.now();
    redactEventDataForType("provider/warning", {
      category: "config",
      details: `Cookie: a=\\"b`.repeat(30_000),
    });
    expect(performance.now() - start).toBeLessThan(1000);
  });
});

describe("round 4: structural collisions", () => {
  const values = [
    "completed",
    "toolCall",
    "synthetic-tool",
    "item/completed",
    "userMessage",
  ];
  for (const value of values) {
    it(`secret equal to ${value} keeps the event valid`, () => {
      const event = toolEvent({ env: { API_KEY: value }, echo: value });
      const out = redactThreadEventPayload(event);
      expect(threadEventSchema.safeParse(out).success).toBe(true);
      const o = out as { item: { status: string; type: string; id: string } };
      expect(o.item.status).toBe("completed");
      expect(o.item.type).toBe("toolCall");
      expect(
        JSON.stringify((out as { item: { result: unknown } }).item.result),
      ).not.toContain(`"echo":"${value}"`);
    });
  }

  it("does not protect free-form result.status", () => {
    const out = JSON.stringify(
      redactThreadEventPayload(
        toolEvent({ env: { API_KEY: "completed" }, status: "completed" }),
      ),
    );
    expect(out).toContain('"status":"completed"');
    expect(out).not.toMatch(/"result":\{[^}]*"status":"completed"/);
  });

  it("structural paths include enum fields", () => {
    const paths = listStructuralPaths();
    expect(paths).toContain("item.status");
    expect(paths).toContain("item.type");
    expect(paths).toContain("type");
  });
});
