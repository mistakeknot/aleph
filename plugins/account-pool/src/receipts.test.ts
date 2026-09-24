import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { PoolReceipts, ResponseEvidence, type ReceiptHop } from "./receipts.js";

describe("receipt failure boundaries", () => {
  it("retains terminal provider usage when transport fails afterward without reporting success", () => {
    const hop: ReceiptHop = {
      index: 1,
      account_id: "account",
      provider: "codex",
      status: 200,
      state: "active",
      model: null,
      usage: null,
    };
    const evidence = new ResponseEvidence(hop, true, true);
    evidence.feed(
      new TextEncoder().encode(
        'data: {"type":"response.completed","response":{"status":"completed","model":"actual","usage":{"input_tokens":3,"output_tokens":2}}}\n\n',
      ),
    );
    evidence.finish("transport_error");
    expect(hop).toMatchObject({
      state: "transport_error",
      model: "actual",
      usage: { input_tokens: 3, output_tokens: 2 },
    });
  });

  it("accepts Claude thinking tokens only as an output subset", () => {
    const hop: ReceiptHop = {
      index: 1,
      account_id: "account",
      provider: "claude",
      status: 200,
      state: "active",
      model: null,
      usage: null,
    };
    const evidence = new ResponseEvidence(hop, false, true);
    evidence.feed(
      new TextEncoder().encode(
        JSON.stringify({
          type: "message",
          stop_reason: "end_turn",
          model: "actual",
          usage: {
            input_tokens: 1,
            output_tokens: 4,
            output_tokens_details: { thinking_tokens: 3 },
          },
        }),
      ),
    );
    evidence.finish();
    expect(hop).toMatchObject({
      state: "complete",
      usage: { input_tokens: 1, output_tokens: 4 },
    });
  });

  it.each([false, true])(
    "accepts recorded Claude usage metadata (stream=%s)",
    (stream) => {
      const recorded = z
        .object({
          message: z.object({
            model: z.string(),
            usage: z.record(z.string(), z.unknown()),
          }),
        })
        .parse(
          JSON.parse(
            readFileSync(
              new URL(
                "../../provider-claude-code/src/__fixtures__/assistant-text.json",
                import.meta.url,
              ),
              "utf8",
            ),
          ),
        );
      const hop: ReceiptHop = {
        index: 1,
        account_id: "account",
        provider: "claude",
        status: 200,
        state: "active",
        model: null,
        usage: null,
      };
      const evidence = new ResponseEvidence(hop, stream, true);
      const usage = { ...recorded.message.usage, speed: null };
      const events = [
        {
          type: "message_start",
          message: { model: recorded.message.model, usage },
        },
        {
          type: "message_delta",
          usage: {
            output_tokens: 34,
            iterations: null,
            speed: null,
            server_tool_use: null,
          },
        },
        { type: "message_stop" },
      ];
      evidence.feed(
        new TextEncoder().encode(
          stream
            ? events
                .map((event) => "data: " + JSON.stringify(event) + "\n\n")
                .join("")
            : JSON.stringify({
                type: "message",
                stop_reason: "end_turn",
                model: recorded.message.model,
                usage,
              }),
        ),
      );
      evidence.finish();
      expect(hop).toMatchObject({
        state: "complete",
        model: recorded.message.model,
        usage: {
          input_tokens: 1523,
          output_tokens: 34,
          cache_read_input_tokens: 1200,
          cache_creation_input_tokens: 0,
        },
      });
      expect(Object.keys(hop.usage ?? {}).sort()).toEqual([
        "cache_creation_input_tokens",
        "cache_read_input_tokens",
        "input_tokens",
        "output_tokens",
      ]);
    },
  );

  it("recycles settled receipts after a fixed polling window without evicting active attempts", () => {
    let now = 0;
    const store = new PoolReceipts(() => now);
    const leases = Array.from({ length: 64 }, (_, i) =>
      leaseSchema.parse(
        store.begin("owner", {
          version: 1,
          provider: "claude",
          attempt_id: String(i),
        }),
      ),
    );
    const first = leases[0]!;
    const attempt = store.identify(first.token)!;
    const request = store.admit(attempt, "claude", "/v1/messages")!;
    request.state = "finished";
    request.hops.push({
      index: 1,
      account_id: "account",
      provider: "claude",
      status: 200,
      state: "complete",
      model: "actual",
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    });
    const seal = () =>
      store.finalize("owner", { version: 1, id: first.id, attempt_id: "0" });
    expect(seal()).toMatchObject({ complete: true });
    now = 9 * 60 * 1000;
    expect(seal()).toMatchObject({ complete: true });
    expect(
      store.begin("owner", {
        version: 1,
        provider: "claude",
        attempt_id: "new",
      }),
    ).toBeNull();
    now = 10 * 60 * 1000;
    expect(seal()).toBeNull();
    expect(store.identify(first.token)).toBeNull();
    expect(store.identify(leases[1]!.token)).not.toBeNull();
    expect(
      store.begin("owner", {
        version: 1,
        provider: "claude",
        attempt_id: "new",
      }),
    ).not.toBeNull();
  });

  const leaseSchema = z.object({ id: z.string(), token: z.string() });
  it("fails closed on restart, expiry, capacity exhaustion and provider mismatch", () => {
    let now = 0;
    const store = new PoolReceipts(() => now);
    const begin = () =>
      leaseSchema.parse(
        store.begin("owner", {
          version: 1,
          provider: "claude",
          attempt_id: "attempt",
        }),
      );
    const first = begin();
    const attempt = store.identify(first.token);
    expect(attempt).not.toBeNull();
    if (attempt === null) throw new Error("missing attempt");
    expect(store.admit(attempt, "codex", "/v1/responses")).toBeNull();
    expect(
      store.finalize("owner", {
        version: 1,
        id: first.id,
        attempt_id: "attempt",
      }),
    ).toMatchObject({ valid: false, complete: false });
    for (let i = 1; i < 64; i++) begin();
    expect(
      store.begin("owner", {
        version: 1,
        provider: "claude",
        attempt_id: "attempt",
      }),
    ).toBeNull();
    now = 24 * 60 * 60 * 1000;
    expect(store.identify(first.token)).toBeNull();
    expect(
      store.finalize("owner", {
        version: 1,
        id: first.id,
        attempt_id: "attempt",
      }),
    ).toBeNull();
    const next = begin();
    store.clear();
    expect(store.identify(next.token)).toBeNull();
    expect(
      store.finalize("owner", {
        version: 1,
        id: next.id,
        attempt_id: "attempt",
      }),
    ).toBeNull();
  });

  it.each([
    "missing-usage",
    "negative",
    "overflow",
    "extra-token-field",
    "oversized-frame",
    "error-after-completion",
  ])("rejects %s evidence", (mode) => {
    const hop: ReceiptHop = {
      index: 1,
      account_id: "account",
      provider: "codex",
      status: 200,
      state: "active",
      model: null,
      usage: null,
    };
    const evidence = new ResponseEvidence(hop, true, true);
    const usage =
      mode === "missing-usage"
        ? undefined
        : {
            input_tokens:
              mode === "negative" ? -1 : mode === "overflow" ? 1e20 : 1,
            output_tokens: 2,
            ...(mode === "extra-token-field" ? { unrecognized_tokens: 9 } : {}),
          };
    evidence.feed(
      new TextEncoder().encode(
        "data: " +
          JSON.stringify({
            type: "response.completed",
            response: { status: "completed", model: "actual", usage },
          }) +
          "\n\n",
      ),
    );
    if (mode === "oversized-frame")
      evidence.feed(new Uint8Array(1024 * 1024 + 1).fill(65));
    if (mode === "error-after-completion")
      evidence.feed(new TextEncoder().encode('data: {"type":"error"}\n\n'));
    evidence.finish();
    expect(hop.state).not.toBe("complete");
    expect(hop.usage).toBeNull();
  });

  it("retains an observed Codex model when its stream truncates before usage", () => {
    const hop: ReceiptHop = {
      index: 1,
      account_id: "account",
      provider: "codex",
      status: 200,
      state: "active",
      model: null,
      usage: null,
    };
    const evidence = new ResponseEvidence(hop, true, true);
    evidence.feed(
      new TextEncoder().encode(
        'data: {"type":"response.created","response":{"model":"observed"}}\n\n',
      ),
    );
    evidence.finish();
    expect(hop).toMatchObject({
      model: "observed",
      usage: null,
      state: "truncated",
    });
  });
});
