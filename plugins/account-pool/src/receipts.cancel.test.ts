import { expect, it } from "vitest";
import { gzipSync } from "node:zlib";
import { ResponseEvidence, type ReceiptHop } from "./receipts.js";

function hop(): ReceiptHop {
  return {
    index: 1,
    account_id: "synthetic",
    provider: "codex",
    status: 200,
    state: "active",
    model: null,
    usage: null,
  };
}

it("keeps an observed terminal complete when the client cancels afterward", () => {
  const result = hop();
  const evidence = new ResponseEvidence(result, true, true);
  evidence.feed(
    new TextEncoder().encode(
      'data: {"type":"response.created","response":{"model":"synthetic-model"}}\n\n' +
        'data: {"type":"response.completed","response":{"status":"completed","model":"synthetic-model","usage":{"input_tokens":24159,"output_tokens":196,"input_tokens_details":{"cached_tokens":12032}}}}\n\n',
    ),
  );
  evidence.finish("cancelled");
  expect(result).toMatchObject({
    state: "complete",
    model: "synthetic-model",
    usage: {
      input_tokens: 12127,
      output_tokens: 196,
      cache_read_input_tokens: 12032,
    },
  });
});

it("keeps cancellation without terminal evidence unknown for model and usage", () => {
  const result = hop();
  const evidence = new ResponseEvidence(result, true, true);
  evidence.finish("cancelled");
  expect(result).toMatchObject({
    state: "cancelled",
    model: null,
    usage: null,
  });
});

it.each([
  ["invalid UTF-8", new Uint8Array([255])],
  ["compressed body", gzipSync('data: {"type":"response.created"}\n\n')],
  ["malformed JSON", new TextEncoder().encode("data: {broken}\n\n")],
  ["unrecognized envelope", new TextEncoder().encode("data: null\n\n")],
  [
    "missing model",
    new TextEncoder().encode(
      'data: {"type":"response.created","response":{}}\n\n',
    ),
  ],
  ["provider error", new TextEncoder().encode('data: {"type":"error"}\n\n')],
  [
    "provider incomplete",
    new TextEncoder().encode('data: {"type":"response.incomplete"}\n\n'),
  ],
  [
    "provider failed",
    new TextEncoder().encode('data: {"type":"response.failed"}\n\n'),
  ],
  [
    "invalid terminal",
    new TextEncoder().encode(
      'data: {"type":"response.completed","response":{"status":"completed","model":"synthetic-model","usage":null}}\n\n',
    ),
  ],
  ["oversized chunk", new Uint8Array(1024 * 1024 + 1).fill(65)],
] as const)(
  "keeps %s failure truncated after client cancellation",
  (_name, bytes) => {
    const result = hop();
    const evidence = new ResponseEvidence(result, true, true);
    evidence.feed(bytes);
    evidence.finish("cancelled");
    expect(result).toMatchObject({
      state: "truncated",
      model: null,
      usage: null,
    });
  },
);

it.each([false, true])(
  "never invents evidence for an unobserved terminal (SSE=%s)",
  (eventStream) => {
    const result = hop();
    const evidence = new ResponseEvidence(result, eventStream, true);
    evidence.feed(new TextEncoder().encode('data: {"type":"unrelated"}\n\n'));
    evidence.finish("cancelled");
    expect(result).toMatchObject({
      state: "cancelled",
      model: null,
      usage: null,
    });
  },
);

it("leaves successful metadata unknown with no model or usage", () => {
  const result = hop();
  const evidence = new ResponseEvidence(result, false, false);
  evidence.feed(new TextEncoder().encode('{"data":[]}'));
  evidence.finish();
  expect(result).toMatchObject({ state: "unknown", model: null, usage: null });
});

it("does not infer a terminal from a buffered JSON body cancelled before EOF", () => {
  const result = hop();
  const evidence = new ResponseEvidence(result, false, true);
  evidence.feed(
    new TextEncoder().encode(
      '{"status":"completed","model":"synthetic-model","usage":{"input_tokens":1,"output_tokens":2}}',
    ),
  );
  evidence.finish("cancelled");
  expect(result).toMatchObject({
    state: "cancelled",
    model: null,
    usage: null,
  });
});

it("retains a model observed before real pre-terminal cancellation without usage", () => {
  const result = hop();
  const evidence = new ResponseEvidence(result, true, true);
  evidence.feed(
    new TextEncoder().encode(
      'data: {"type":"response.created","response":{"model":"synthetic-model"}}\n\n',
    ),
  );
  evidence.finish("cancelled");
  expect(result).toMatchObject({
    state: "cancelled",
    model: "synthetic-model",
    usage: null,
  });
});

it.each([
  {
    input_tokens: 1,
    output_tokens: 2,
    input_tokens_details: { cached_tokens: 2 },
  },
  {
    input_tokens: 1,
    output_tokens: 2,
    output_tokens_details: { reasoning_tokens: 3 },
  },
  { input_tokens: 1, output_tokens: 2, total_tokens: 4 },
])("rejects inconsistent terminal counts before observing a model", (usage) => {
  const result = hop();
  const evidence = new ResponseEvidence(result, true, true);
  evidence.feed(
    new TextEncoder().encode(
      `data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", model: "synthetic-model", usage } })}\n\n`,
    ),
  );
  evidence.finish("cancelled");
  expect(result).toMatchObject({
    state: "truncated",
    model: null,
    usage: null,
  });
});

it("preserves Claude terminal usage across a later client cancellation", () => {
  const result = hop();
  result.provider = "claude";
  const evidence = new ResponseEvidence(result, true, true);
  evidence.feed(
    new TextEncoder().encode(
      'data: {"type":"message_start","message":{"model":"synthetic-model","usage":{"input_tokens":3,"output_tokens":0}}}\n\n' +
        'data: {"type":"message_delta","usage":{"output_tokens":2}}\n\n' +
        'data: {"type":"message_stop"}\n\n',
    ),
  );
  evidence.finish("cancelled");
  expect(result).toMatchObject({
    state: "complete",
    model: "synthetic-model",
    usage: { input_tokens: 3, output_tokens: 2 },
  });
});

it.each([
  new TextEncoder().encode('data: {"type":"response.created"'),
  new Uint8Array([0xe2, 0x82]),
])(
  "does not treat a client-cut partial frame as an observed parse failure",
  (bytes) => {
    const result = hop();
    const evidence = new ResponseEvidence(result, true, true);
    evidence.feed(bytes);
    evidence.finish("cancelled");
    expect(result).toMatchObject({
      state: "cancelled",
      model: null,
      usage: null,
    });
  },
);
