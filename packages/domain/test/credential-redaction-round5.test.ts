import { describe, expect, it } from "vitest";
import {
  redactEventDataForType,
  redactThreadEventPayload,
  threadEventSchema,
  threadScope,
  turnScope,
} from "../src/index.js";

const SECRET = "synthetic-review-token-1234";

function sanitize(type: string, data: Record<string, unknown>) {
  const scope = type.startsWith("item/") ? turnScope("synthetic-turn") : threadScope();
  const event = {
    type,
    threadId: "thr_synthetic",
    providerThreadId: "synthetic-provider",
    scope,
    ...data,
  };
  const parsed = threadEventSchema.parse(event);
  const out = redactThreadEventPayload(parsed);
  // Always schema-valid, and stable on a second pass.
  expect(threadEventSchema.safeParse(out).success).toBe(true);
  expect(redactThreadEventPayload(out)).toEqual(out);
  return out as Record<string, unknown>;
}

describe("round 5: matcher overlap never exposes a credential prefix", () => {
  it("renders the union of overlapping matches", () => {
    const token = `${SECRET}bbbbbbbbsynthetic-middle-ccccccccsynthetic-tail`;
    const out = sanitize("item/completed", {
      item: {
        type: "toolCall",
        id: "synthetic-tool",
        tool: "probe",
        status: "completed",
        result: {
          env: { API_KEY: token, SECRET_A: "aaaaaaaa", SECRET_B: "bbbbbbbb", SECRET_C: "cccccccc" },
          echo: `aaaaaaaa${token}`,
        },
      },
    });
    const text = JSON.stringify(out);
    for (const part of ["synthetic-review", "token-1234", "synthetic-middle", "synthetic-tail"]) {
      expect(text).not.toContain(part);
    }
    expect(JSON.stringify(out)).toContain("[redacted]");
  });
});

describe("round 5: structural paths follow the event variant", () => {
  it("scrubs free-form extension payload kind echoes", () => {
    const out = sanitize("thread/extensionState/updated", {
      kind: "synthetic/state",
      payload: { env: { API_KEY: SECRET }, kind: SECRET },
    }) as { kind: string; payload: { kind: string } };
    expect(JSON.stringify(out)).not.toContain(SECRET);
    expect(out.kind).toBe("synthetic/state");
  });

  it("scrubs system/operation status and metadata echoes", () => {
    const out = sanitize("system/operation", {
      operation: "probe",
      operationId: "synthetic-operation",
      status: SECRET,
      message: "safe",
      metadata: { env: { API_KEY: SECRET }, status: SECRET },
    }) as Record<string, unknown>;
    expect(JSON.stringify(out)).not.toContain(SECRET);
    expect(out.operationId).toBe("synthetic-operation");
  });
});

describe("round 5: client turn requests keep prompt text, mask params", () => {
  for (const type of ["client/turn/start", "client/turn/requested"]) {
    it(`${type} params`, () => {
      const params = {
        authorization: `Bearer ${SECRET}`,
        note: `Authorization: Bearer ${SECRET}`,
        input: [{ type: "text", text: "safe authored prompt" }],
      };
      const data = {
        direction: "outbound",
        source: "tell",
        initiator: "user",
        request: { method: "turn/start", params },
      };
      const out = redactEventDataForType(type, data);
      expect(JSON.stringify(out)).not.toContain(SECRET);
      expect(JSON.stringify(out)).toContain("safe authored prompt");
    });
  }
});

describe("round 5: redaction markers never shield later values", () => {
  const headers = [
    "Cookie",
    "Set-Cookie",
    "Authorization",
    "Proxy-Authorization",
    "X-Api-Key",
    "X-Auth-Token",
    "X-Access-Token",
  ];
  for (const name of headers) {
    it(`${name} after a marker`, () => {
      const out = sanitize("provider/warning", {
        category: "config",
        details: `${name}: [redacted]; sid=${SECRET}`,
      });
      expect(JSON.stringify(out)).not.toContain(SECRET);
    });
  }

  it("Digest values with internal escaped quotes", () => {
    for (const quotes of ['a\\"b\\"c', 'a\\\\\\"b\\\\\\"c']) {
      const out = sanitize("provider/warning", {
        category: "config",
        details: `Authorization: Digest username="${quotes}", response="${SECRET}"`,
      });
      expect(JSON.stringify(out)).not.toContain(SECRET);
    }
  });
});

describe("round 5: output stays schema-valid", () => {
  it("keeps a refined extension kind", () => {
    const out = sanitize("item/completed", {
      item: {
        type: "extension",
        id: "synthetic-ext",
        kind: "synthetic/state",
        status: "completed",
        payload: { env: { API_KEY: "synthetic/state" } },
        presentation: {
          label: { pending: "Working", completed: "Done" },
          icon: { glyph: "x" },
        },
      },
    });
    expect((out.item as { kind: string }).kind).toBe("synthetic/state");
  });

  it("keeps bounded presentation detail within its maximum", () => {
    const out = sanitize("item/completed", {
      item: {
        type: "toolCall",
        id: "synthetic-tool",
        tool: "probe",
        status: "completed",
        result: { env: { API_KEY: "abcdefgh" } },
        presentation: {
          label: { pending: "Working", completed: "Done" },
          icon: { glyph: "x" },
          detail: `abcdefgh${"x".repeat(272)}`,
        },
      },
    }) as { item: { presentation: { detail: string } } };
    expect(out.item.presentation.detail.length).toBeLessThanOrEqual(280);
    expect(out.item.presentation.detail).not.toContain("abcdefgh");
  });
});

describe("round 5: fuzz schema validity with secret collisions", () => {
  function prng(seed: number) {
    let s = seed >>> 0;
    return () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 2 ** 32;
    };
  }

  it("sanitized events always pass threadEventSchema", () => {
    const rand = prng(20261003);
    const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)]!;
    const secrets = ["abcdefgh", "completed", "toolCall", "x", "synthetic/state", "synthetic-tool"];
    for (let i = 0; i < 300; i += 1) {
      const secret = pick(secrets);
      const pad = "y".repeat(Math.floor(rand() * 280));
      const mix = () => (rand() < 0.5 ? secret : `${secret}${pad}`.slice(0, 280 - secret.length));
      const events: Array<[string, Record<string, unknown>]> = [
        ["item/completed", {
          item: {
            type: "toolCall",
            id: pick(["synthetic-tool", secret]),
            tool: "probe",
            status: "completed",
            result: { env: { API_KEY: secret }, echo: mix(), status: secret },
            presentation: {
              label: { pending: "Working", completed: "Done" },
              icon: { glyph: "x" },
              detail: mix(),
            },
          },
        }],
        ["thread/extensionState/updated", {
          kind: pick(["synthetic/state", secret]),
          payload: { env: { API_KEY: secret }, kind: secret, deep: [mix()] },
        }],
        ["system/operation", {
          operation: "probe",
          operationId: "synthetic-operation",
          status: secret,
          message: mix(),
          metadata: { env: { API_KEY: secret }, status: secret },
        }],
      ];
      for (const [type, data] of events) {
        const scope = type.startsWith("item/") ? turnScope("synthetic-turn") : threadScope();
        const base = {
          type,
          threadId: "thr_synthetic",
          providerThreadId: "synthetic-provider",
          scope,
          ...data,
        };
        if (!threadEventSchema.safeParse(base).success) {
          continue; // the collision itself made the input invalid
        }
        const out = redactThreadEventPayload(base);
        const result = threadEventSchema.safeParse(out);
        expect(result.success, `${type}#${i} ${secret}`).toBe(true);
      }
    }
  });
});

describe("round 5: data-only payloads stay schema-valid too", () => {
  it("truncates bounded detail when only the data payload is redacted", () => {
    const data = {
      item: {
        type: "toolCall",
        id: "synthetic-tool",
        tool: "probe",
        status: "completed",
        result: { env: { API_KEY: "abcdefgh" } },
        presentation: {
          label: { pending: "Working", completed: "Done" },
          icon: { glyph: "x" },
          detail: `abcdefgh${"x".repeat(272)}`,
        },
      },
    };
    const out = redactEventDataForType("item/completed", data);
    expect(out.item.presentation.detail.length).toBeLessThanOrEqual(280);
    expect(out.item.presentation.detail).not.toContain("abcdefgh");
  });
});
