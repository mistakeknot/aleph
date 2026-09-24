import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import type { PoolProvider } from "./contracts.js";

const nonce = z.string().regex(/^[A-Za-z0-9._-]{1,128}$/u);
export const receiptBeginSchema = z
  .object({
    version: z.literal(1),
    provider: z.enum(["claude", "codex"]),
    attempt_id: nonce,
  })
  .strict();
export const receiptFinalizeSchema = z
  .object({
    version: z.literal(1),
    id: z.string().regex(/^[a-f0-9]{32}$/u),
    attempt_id: nonce,
  })
  .strict();
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const model = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/u);
const thinkingDetails = z.object({ thinking_tokens: count }).strict();
const usageSchema = z
  .object({
    input_tokens: count,
    output_tokens: count,
    output_tokens_details: thinkingDetails.optional(),
    cache_read_input_tokens: count.default(0),
    cache_creation_input_tokens: count.default(0),
    cache_creation: z
      .object({
        ephemeral_5m_input_tokens: count,
        ephemeral_1h_input_tokens: count,
      })
      .nullable()
      .optional(),
    iterations: z.unknown().optional(),
    speed: z.unknown().optional(),
    server_tool_use: z.unknown().optional(),
    service_tier: z.string().nullable().optional(),
    inference_geo: z.string().nullable().optional(),
  })
  .strict()
  .refine(
    (usage) =>
      (usage.output_tokens_details?.thinking_tokens ?? 0) <=
      usage.output_tokens,
  )
  .transform(
    ({
      input_tokens,
      output_tokens,
      cache_read_input_tokens,
      cache_creation_input_tokens,
    }) => ({
      input_tokens,
      output_tokens,
      cache_read_input_tokens,
      cache_creation_input_tokens,
    }),
  );
type Usage = z.infer<typeof usageSchema>;

export interface ReceiptHop {
  index: number;
  account_id: string;
  provider: PoolProvider;
  status: number | null;
  state:
    | "active"
    | "complete"
    | "unknown"
    | "rejected"
    | "cancelled"
    | "truncated"
    | "transport_error";
  model: string | null;
  usage: Usage | null;
}

export interface ReceiptRequest {
  id: number;
  kind: "inference" | "metadata";
  state: "active" | "finished" | "cancelled" | "error";
  hops: ReceiptHop[];
}

interface Attempt {
  id: string;
  host_id: string;
  attempt_id: string;
  provider: PoolProvider;
  expires_at: number;
  token_hash: string;
  sealed: boolean;
  valid: boolean;
  requests: ReceiptRequest[];
}

function digest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export class PoolReceipts {
  private readonly attempts = new Map<string, Attempt>();
  private readonly tokens = new Map<string, Attempt>();

  constructor(private readonly now: () => number) {}

  clear(): void {
    this.attempts.clear();
    this.tokens.clear();
  }

  begin(
    hostId: string,
    input: z.infer<typeof receiptBeginSchema>,
  ): object | null {
    for (const [id, attempt] of this.attempts) {
      if (attempt.expires_at <= this.now()) {
        this.attempts.delete(id);
        this.tokens.delete(attempt.token_hash);
      }
    }
    if (this.attempts.size >= 64) return null;
    const token = "pool-attempt-" + randomBytes(32).toString("base64url");
    const attempt: Attempt = {
      id: randomBytes(16).toString("hex"),
      host_id: hostId,
      ...input,
      expires_at: this.now() + 24 * 60 * 60 * 1000,
      token_hash: digest(token),
      sealed: false,
      valid: true,
      requests: [],
    };
    this.attempts.set(attempt.id, attempt);
    this.tokens.set(attempt.token_hash, attempt);
    return {
      version: 1,
      id: attempt.id,
      host_id: hostId,
      attempt_id: input.attempt_id,
      provider: input.provider,
      token,
      expires_at: attempt.expires_at,
    };
  }

  identify(token: string): Attempt | null {
    const attempt = this.tokens.get(digest(token));
    return attempt !== undefined && attempt.expires_at > this.now()
      ? attempt
      : null;
  }

  admit(
    attempt: Attempt,
    provider: PoolProvider,
    route: string,
  ): ReceiptRequest | null {
    if (attempt.sealed || !attempt.valid || attempt.expires_at <= this.now())
      return null;
    if (
      attempt.provider !== provider ||
      attempt.requests.length >= 128 ||
      ![
        "/v1/responses",
        "/v1/messages",
        "/v1/messages/count_tokens",
        "/v1/models",
        "/v1/images/generations",
        "/v1/images/edits",
        "/v1/alpha/search",
      ].includes(route)
    ) {
      attempt.valid = false;
      return null;
    }
    const request: ReceiptRequest = {
      id: attempt.requests.length + 1,
      kind:
        route === "/v1/messages/count_tokens" || route === "/v1/models"
          ? "metadata"
          : "inference",
      state: "active",
      hops: [],
    };
    attempt.requests.push(request);
    return request;
  }

  finalize(
    hostId: string,
    input: z.infer<typeof receiptFinalizeSchema>,
  ): object | null {
    const attempt = this.attempts.get(input.id);
    if (
      attempt === undefined ||
      attempt.host_id !== hostId ||
      attempt.attempt_id !== input.attempt_id ||
      attempt.expires_at <= this.now()
    )
      return null;
    attempt.sealed = true;
    const complete =
      attempt.valid &&
      attempt.requests.length > 0 &&
      attempt.requests.every(
        (request) =>
          request.state !== "active" &&
          request.hops.every((hop) => hop.state !== "active"),
      );
    if (complete)
      attempt.expires_at = Math.min(
        attempt.expires_at,
        this.now() + 10 * 60 * 1000,
      );
    return {
      version: 1,
      id: attempt.id,
      host_id: attempt.host_id,
      attempt_id: attempt.attempt_id,
      provider: attempt.provider,
      sealed: true,
      valid: attempt.valid,
      complete,
      requests: attempt.requests,
    };
  }
}

export class ResponseEvidence {
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });
  private buffer = "";
  private invalid = false;
  private terminal = false;
  private delta = false;
  private observedModel: string | null = null;
  private usage: Usage | null = null;
  private finished = false;

  constructor(
    readonly hop: ReceiptHop,
    private readonly eventStream: boolean,
    private readonly billable: boolean,
  ) {}

  feed(bytes: Uint8Array): void {
    if (
      this.invalid ||
      !this.billable ||
      this.finished ||
      (this.hop.status ?? 500) >= 400
    )
      return;
    try {
      this.buffer += this.decoder.decode(bytes, { stream: true });
      if (this.buffer.length > 1024 * 1024) throw new Error("oversized frame");
      if (!this.eventStream) return;
      this.buffer = this.buffer.replace(/\r\n/gu, "\n");
      let end: number;
      while ((end = this.buffer.indexOf("\n\n")) >= 0) {
        const frame = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 2);
        const data = frame
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (data && data !== "[DONE]") this.observe(JSON.parse(data));
      }
    } catch {
      this.invalid = true;
      this.buffer = "";
    }
  }

  private observe(value: unknown): void {
    const envelope = z
      .object({
        type: z.string().optional(),
        model: z.unknown().optional(),
        usage: z.unknown().optional(),
        response: z.unknown().optional(),
        message: z.unknown().optional(),
        status: z.string().optional(),
        stop_reason: z.string().nullable().optional(),
      })
      .parse(value);
    if (this.terminal) throw new Error("event after terminal");
    if (
      envelope.type === "error" ||
      envelope.type === "response.failed" ||
      envelope.type === "response.incomplete"
    )
      throw new Error("provider error");
    if (this.hop.provider === "codex") {
      if (
        this.eventStream &&
        ["response.created", "response.in_progress"].includes(
          envelope.type ?? "",
        )
      ) {
        const response = z.object({ model }).parse(envelope.response);
        if (
          this.observedModel !== null &&
          this.observedModel !== response.model
        )
          throw new Error("conflicting model");
        this.observedModel = response.model;
        return;
      }
      if (this.eventStream && envelope.type !== "response.completed") return;
      const response = z
        .object({
          status: z.literal("completed"),
          model,
          usage: z
            .object({
              input_tokens: count,
              output_tokens: count,
              total_tokens: count.optional(),
              input_tokens_details: z
                .object({ cached_tokens: count })
                .strict()
                .optional(),
              output_tokens_details: z
                .object({ reasoning_tokens: count })
                .strict()
                .optional(),
            })
            .strict(),
        })
        .parse(this.eventStream ? envelope.response : value);
      const cached = response.usage.input_tokens_details?.cached_tokens ?? 0;
      if (cached > response.usage.input_tokens)
        throw new Error("invalid cached subset");
      if (
        (response.usage.output_tokens_details?.reasoning_tokens ?? 0) >
          response.usage.output_tokens ||
        (response.usage.total_tokens !== undefined &&
          response.usage.total_tokens !==
            response.usage.input_tokens + response.usage.output_tokens)
      )
        throw new Error("invalid usage total");
      if (this.observedModel !== null && this.observedModel !== response.model)
        throw new Error("conflicting model");
      this.observedModel = response.model;
      this.usage = {
        input_tokens: response.usage.input_tokens - cached,
        output_tokens: response.usage.output_tokens,
        cache_read_input_tokens: cached,
        cache_creation_input_tokens: 0,
      };
      this.terminal = true;
    } else if (!this.eventStream) {
      if (envelope.type !== "message" || !envelope.stop_reason)
        throw new Error("unfinished message");
      this.observedModel = model.parse(envelope.model);
      this.usage = usageSchema.parse(envelope.usage);
      this.terminal = true;
    } else if (envelope.type === "message_start") {
      if (this.observedModel !== null) throw new Error("duplicate start");
      const message = z
        .object({ model, usage: usageSchema })
        .parse(envelope.message);
      this.observedModel = message.model;
      this.usage = message.usage;
    } else if (envelope.type === "message_delta") {
      if (this.usage === null) throw new Error("missing start");
      const update = z
        .object({
          input_tokens: count.optional(),
          output_tokens: count,
          output_tokens_details: thinkingDetails.optional(),
          cache_read_input_tokens: count.optional(),
          cache_creation_input_tokens: count.optional(),
          iterations: z.unknown().optional(),
          speed: z.unknown().optional(),
          server_tool_use: z.unknown().optional(),
        })
        .strict()
        .refine(
          (usage) =>
            (usage.output_tokens_details?.thinking_tokens ?? 0) <=
            usage.output_tokens,
        )
        .transform(
          ({
            iterations: _iterations,
            speed: _speed,
            server_tool_use: _tools,
            output_tokens_details: _details,
            ...counts
          }) => counts,
        )
        .parse(envelope.usage);
      if (update.output_tokens === undefined) throw new Error("missing output");
      this.usage = { ...this.usage, ...update };
      this.delta = true;
    } else if (envelope.type === "message_stop") {
      if (!this.delta) throw new Error("missing final usage");
      this.terminal = true;
    }
  }

  finish(state?: "cancelled" | "transport_error" | "rejected"): void {
    if (this.finished) return;
    this.finished = true;
    try {
      this.buffer += this.decoder.decode();
      if (
        !this.eventStream &&
        this.billable &&
        !state &&
        (this.hop.status ?? 500) < 400
      )
        this.observe(JSON.parse(this.buffer));
      if (this.eventStream && this.buffer.trim()) this.invalid = true;
    } catch {
      this.invalid = true;
    }
    this.buffer = "";
    this.hop.model = this.observedModel;
    this.hop.state =
      state ??
      ((this.hop.status ?? 500) >= 400
        ? "rejected"
        : this.invalid || (this.billable && !this.terminal)
          ? "truncated"
          : !this.billable
            ? "unknown"
            : "complete");
    this.hop.usage = this.terminal && !this.invalid ? this.usage : null;
  }
}
