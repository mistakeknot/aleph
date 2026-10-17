import { describe, expect, it } from "vitest";
import {
  redactEventDataForType,
  redactEventDataJsonForType,
  redactThreadEventPayload,
  threadEventSchema,
  threadScope,
  turnScope,
} from "../src/index.js";

const TAIL = "synthetic-tail-credential-1234";
const HEADERS = [
  "Cookie",
  "Set-Cookie",
  "Authorization",
  "Proxy-Authorization",
  "X-Api-Key",
  "X-Auth-Token",
  "X-Access-Token",
];

function details(text: string): string {
  const out = redactEventDataForType("provider/warning", {
    category: "config",
    details: text,
  }) as { details: string };
  expect(
    redactEventDataForType("provider/warning", out),
    "idempotent",
  ).toEqual(out);
  return out.details;
}

/** Redacts a full event; always schema-valid and idempotent afterwards. */
function sanitize(type: string, data: Record<string, unknown>) {
  let event: unknown;
  for (const scope of [turnScope("synthetic-turn"), threadScope()]) {
    const candidate = {
      type,
      threadId: "thr_synthetic",
      providerThreadId: "synthetic-provider",
      ...data,
      scope,
    };
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

/** A valid `client/turn/requested` payload around the given pieces. */
function requested(
  params: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) {
  return {
    direction: "outbound",
    requestId: "creq_23456789ab",
    source: "tell",
    initiator: "user",
    senderThreadId: null,
    input: [{ type: "text", text: "safe authored prompt" }],
    target: { kind: "new-turn" },
    request: { method: "turn/start", params },
    execution: {
      model: "gpt-5",
      serviceTier: "default",
      reasoningLevel: "medium",
      permissionMode: "full",
      source: "client/turn/requested",
    },
    ...extra,
  };
}

const bs = (n: number) => "\\".repeat(n);

describe("round 7: a closed quote is not an open string", () => {
  for (const name of HEADERS) {
    for (const depth of [0, 1, 2, 3, 4, 5]) {
      it(`${name} after a closed string, depth ${depth}`, () => {
        const q = `${bs(depth)}"`;
        const out = details(`earlier ${q}ok${q}; ${name}: prefix${q}${TAIL}`);
        expect(out).not.toContain(TAIL);
        expect(out.startsWith(`earlier ${q}ok${q}; ${name}: [redacted]`)).toBe(
          true,
        );
      });
    }
  }

  it("covers apostrophes, contractions, mixed kinds and several closed strings", () => {
    for (const text of [
      `earlier 'ok'; Cookie: prefix'${TAIL}`,
      `earlier \\'ok\\'; Cookie: prefix\\'${TAIL}`,
      `it's fine; Cookie: prefix'${TAIL}`,
      `don't "a" 'b' "c"; Cookie: prefix"${TAIL}`,
      `"a" "b" 'c' "d"; Cookie: p"${TAIL}`,
      `say "a 'b' c" and then Cookie: p'${TAIL}`,
      `${bs(3)}"x${bs(3)}" ${bs(1)}"y${bs(1)}" Cookie: p${bs(1)}"${TAIL}`,
      `{"a":"b","c":"d"} Cookie: p"${TAIL}`,
      `line one "closed"\nCookie: p"${TAIL}`,
      `5" pipe; Cookie: p"${TAIL}`,
      `"a" 'it's' Cookie: p'${TAIL}`,
      `'a'b'c' Cookie: p'${TAIL}`,
      `Cookie: a\\"b; Authorization: c\\"${TAIL}`,
    ]) {
      expect(details(text), text).not.toContain(TAIL);
    }
  });

  it("keeps text after a genuinely enclosing quote", () => {
    for (const [text, rest] of [
      [`earlier "ok" then curl -H 'Cookie: sid=${TAIL}' next`, "next"],
      [`x ${bs(1)}"Cookie: sid=${TAIL}${bs(1)}" next`, "next"],
      [`a 'b' c "X-Api-Key: ${TAIL}" next`, "next"],
    ] as const) {
      const out = details(text);
      expect(out, text).not.toContain(TAIL);
      expect(out, text).toContain(rest);
    }
  });

  it("scales linearly with many quotes", () => {
    const run = (n: number) => {
      const text = `"a" \\"b\\" 'c' Cookie: x\\"y `.repeat(n);
      const start = performance.now();
      details(text);
      return performance.now() - start;
    };
    run(2000);
    const small = Math.max(run(10000), 1);
    const large = run(40000);
    expect(large / small).toBeLessThan(12);
  });
});

describe("round 7: URL credential values end only at a parameter boundary", () => {
  const image = (url: string) =>
    (
      sanitize("item/completed", {
        item: {
          type: "userMessage",
          id: "synthetic-message",
          content: [{ type: "image", url }],
        },
      }) as { item: { content: { url: string }[] } }
    ).item.content[0]?.url ?? "";

  const values = [
    `prefix'${TAIL}`,
    `prefix"${TAIL}`,
    `prefix ${TAIL}`,
    `prefix<${TAIL}`,
    `prefix>${TAIL}`,
    `prefix;${TAIL}`,
    `prefix#${TAIL}`,
    `'${TAIL}'`,
    `"${TAIL}"`,
    `prefix\t${TAIL}`,
    `prefix${bs(1)}'${TAIL}`,
  ];
  for (const sep of ["?", "#", "&", ";"]) {
    for (const value of values) {
      it(`${JSON.stringify(sep + "token=" + value)}`, () => {
        const base = sep === "&" || sep === ";" ? "?a=1" : "";
        const url = image(`https://example.invalid/i${base}${sep}token=${value}&ok=1`);
        expect(url).not.toContain(TAIL);
        expect(url).toContain("ok=1");
      });
    }
  }

  it("masks every credential parameter name form, position and encoding", () => {
    for (const url of [
      `https://e.invalid/i?ok=1&token=a'${TAIL}`,
      `https://e.invalid/i?ok=1;token=a'${TAIL}`,
      `https://e.invalid/i?ok=1#access_token=a'${TAIL}`,
      `https://e.invalid/i?%74oken=a'${TAIL}`,
      `https://e.invalid/i?a=1&%73ig=a'${TAIL}`,
      `https://e.invalid/i?a=1&amp;token=a'${TAIL}`,
      `https://e.invalid/i?api_key=a"${TAIL}`,
      `https://e.invalid/i?X-Amz-Signature=a'${TAIL}`,
      `//e.invalid/i?sig=a'${TAIL}`,
      `https://e.invalid/i?next=https%3A%2F%2Fo.invalid%2F%3Ftoken%3Da%27${TAIL}%26k%3D1&ok=1`,
      `https://e.invalid/i?a=%3Fsig%3D${TAIL}`,
      `https://e.invalid/i?token=a&token=b'${TAIL}`,
      `https://e.invalid/i?ok=1;ok=2;token=a'${TAIL}`,
    ]) {
      expect(image(url), url).not.toContain(TAIL);
    }
  });

  it("preserves unrelated parameters and stays a parseable URL", () => {
    const url = image(`https://e.invalid/i?design=1&token=a'${TAIL}&author=2&ok=3`);
    expect(url).toBe("https://e.invalid/i?design=1&token=[redacted]&author=2&ok=3");
    expect(() => new URL(url)).not.toThrow();
  });

  it("applies to the stricter request input url schema", () => {
    const out = sanitize(
      "client/turn/requested",
      requested(
        {},
        {
          input: [
            { type: "image", url: `https://e.invalid/i?token=a'${TAIL}&ok=1` },
          ],
        },
      ),
    );
    expect(JSON.stringify(out)).not.toContain(TAIL);
  });
});

describe("round 7: nested request image URLs get the URL override", () => {
  const url = (name = "%74oken") =>
    `https://example.invalid/i?${name}=a'${TAIL}&ok=1`;
  const image = { type: "image", url: url() };
  const shapes: Record<string, Record<string, unknown>> = {
    "params.inputGroups": { inputGroups: [[image]] },
    "params.input": { input: [image] },
    "params.inputGroups deeper": { inputGroups: [[[image]]] },
    "params.messages[*].content[*]": { messages: [{ content: [image] }] },
    "params.input_image url key": {
      input: [{ type: "input_image", image_url: url() }],
    },
    "params.source.url": {
      input: [{ type: "image", source: { type: "url", url: url() } }],
    },
    "params.image_url.url": {
      messages: [{ content: [{ type: "image_url", image_url: { url: url() } }] }],
    },
    "params.attachments[*].href": { attachments: [{ href: url() }] },
    "params.urls array": { urls: [url()] },
    "params.url without type": { input: [{ url: url() }] },
  };
  for (const type of ["client/turn/requested", "client/turn/start"]) {
    for (const [label, params] of Object.entries(shapes)) {
      it(`${type} ${label}`, () => {
        const out =
          type === "client/turn/requested"
            ? sanitize(type, requested(params))
            : sanitize(type, {
                direction: "outbound",
                source: "tell",
                initiator: "user",
                request: { method: "turn/start", params },
              });
        expect(JSON.stringify(out)).not.toContain(TAIL);
        expect(JSON.stringify(out)).toContain("ok=1");
      });
    }
  }

  it("keeps authored prompt text in params untouched", () => {
    const out = sanitize(
      "client/turn/requested",
      requested({
        input: [{ type: "text", text: "visit ?sig=prompt-sig-1 now" }],
      }),
    );
    expect(JSON.stringify(out)).toContain("prompt-sig-1");
  });

  it("covers nested URL fields in item events", () => {
    for (const item of [
      {
        type: "webFetch",
        id: "synthetic",
        url: url(),
        prompt: null,
        pattern: null,
        resultText: null,
      },
      {
        type: "userMessage",
        id: "synthetic",
        content: [{ type: "image", url: url() }],
      },
    ]) {
      const out = sanitize("item/completed", { item });
      expect(JSON.stringify(out)).not.toContain(TAIL);
    }
  });
});

describe("round 7: the JSON precheck does not skip signed URLs", () => {
  const data = (u: string) => ({
    item: {
      type: "userMessage",
      id: "synthetic",
      content: [{ type: "image", url: u }],
    },
  });

  for (const u of [
    "//example.invalid/img?sig=synthtail-123456789xyz",
    "data:text/plain,x#sig=synthtail-123456789xyz",
    "/relative/img?sig=synthtail-123456789xyz",
    "img.png?sig=synthtail-123456789xyz",
    "?sig=synthtail-123456789xyz",
    "#sig=synthtail-123456789xyz",
    "x;sig=synthtail-123456789xyz",
  ]) {
    it(`${u}`, () => {
      const json = JSON.stringify(data(u));
      const viaJson = redactEventDataJsonForType("item/completed", json);
      expect(viaJson).not.toContain("synthtail-123456789xyz");
      expect(JSON.parse(viaJson)).toEqual(
        redactEventDataForType("item/completed", data(u)),
      );
    });
  }

  it("agrees with the object path for every type that has URL overrides", () => {
    const u = "//example.invalid/img?sig=synthtail-123456789xyz";
    for (const [type, payload] of [
      ["item/completed", data(u)],
      ["item/started", data(u)],
      ["item/toolCall/progress", { item: { url: u } }],
      [
        "client/turn/requested",
        { request: { method: "turn/start", params: { input: [{ type: "image", url: u }] } } },
      ],
      [
        "client/turn/start",
        { request: { method: "turn/start", params: { inputGroups: [[{ type: "image", url: u }]] } } },
      ],
    ] as const) {
      const out = redactEventDataJsonForType(type, JSON.stringify(payload));
      expect(out, type).not.toContain("synthtail-123456789xyz");
    }
  });

  it("still skips parsing ordinary output without credential-shaped text", () => {
    const json = JSON.stringify({ item: { type: "commandExecution", aggregatedOutput: "plain output" } });
    expect(redactEventDataJsonForType("item/commandExecution/outputDelta", json)).toBe(json);
  });
});
