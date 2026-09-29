import { z } from "zod";

const KIB = 1024;
const MIB = 1024 * KIB;

export const RELAY_PROTOCOL_VERSION = 1 as const;

export const RELAY_TEXT_MAX_BYTES = 32 * KIB;
export const RELAY_ATTACHMENTS_MAX_COUNT = 4;
export const RELAY_ATTACHMENT_MAX_BYTES = 5 * MIB;
export const RELAY_ATTACHMENTS_TOTAL_MAX_BYTES = 10 * MIB;
export const RELAY_ATTACHMENT_MAX_BASE64_CHARS =
  4 * Math.ceil(RELAY_ATTACHMENT_MAX_BYTES / 3);
export const RELAY_ATTACHMENTS_TOTAL_MAX_BASE64_CHARS =
  4 * Math.ceil(RELAY_ATTACHMENTS_TOTAL_MAX_BYTES / 3);
export const RELAY_REQUEST_BODY_MAX_BYTES = 16 * MIB;
export const RELAY_THREAD_ID_MAX_CHARS = 128;
export const RELAY_FILENAME_MAX_CHARS = 255;
export const RELAY_MIME_TYPE_MAX_CHARS = 127;

export const RELAY_HOST_BUCKET_CAPACITY = 30;
export const RELAY_HOST_BUCKET_REFILL_MS = 10_000;
export const RELAY_THREAD_BUCKET_CAPACITY = 10;
export const RELAY_THREAD_BUCKET_REFILL_MS = 60_000;
export const RELAY_HOST_DAILY_RESERVATIONS = 1000;
export const RELAY_HOST_DAILY_ATTACHMENT_BYTES = 256 * MIB;
export const RELAY_HOST_LIVE_RESERVATIONS = 4;
export const RELAY_TARGET_QUEUE_DEPTH = 50;
export const RELAY_DAEMON_CONCURRENCY = 4;

export const RELAY_ERROR_CODES = [
  "invalid_request",
  "message_expired",
  "payload_too_large",
  "idempotency_conflict",
  "target_not_allowed",
  "target_unavailable",
  "relay_in_progress",
  "rate_limited",
  "target_queue_full",
  "relay_busy",
  "relay_quota_exhausted",
  "daemon_disconnected",
  "server_unreachable",
  "host_revoked",
  "relay_unsupported_platform",
  "relay_protocol_mismatch",
  "browser_request_forbidden",
  "human_session_required",
  "internal_error",
] as const;
export const relayErrorCodeSchema = z.enum(RELAY_ERROR_CODES);
export type RelayErrorCode = z.infer<typeof relayErrorCodeSchema>;

export const RELAY_ERROR_HTTP_STATUS = {
  invalid_request: 400,
  message_expired: 400,
  payload_too_large: 413,
  idempotency_conflict: 409,
  target_not_allowed: 403,
  target_unavailable: 409,
  relay_in_progress: 409,
  rate_limited: 429,
  target_queue_full: 429,
  relay_busy: 429,
  relay_quota_exhausted: 429,
  daemon_disconnected: 503,
  server_unreachable: 503,
  host_revoked: 401,
  relay_unsupported_platform: 501,
  relay_protocol_mismatch: 503,
  browser_request_forbidden: 403,
  human_session_required: 403,
  internal_error: 500,
} as const satisfies Record<RelayErrorCode, number>;

export const RELAY_ERROR_RETRYABLE = {
  invalid_request: false,
  message_expired: false,
  payload_too_large: false,
  idempotency_conflict: false,
  target_not_allowed: false,
  target_unavailable: false,
  relay_in_progress: true,
  rate_limited: true,
  target_queue_full: true,
  relay_busy: true,
  relay_quota_exhausted: true,
  daemon_disconnected: true,
  server_unreachable: true,
  host_revoked: true,
  relay_unsupported_platform: false,
  relay_protocol_mismatch: true,
  browser_request_forbidden: false,
  human_session_required: false,
  internal_error: true,
} as const satisfies Record<RelayErrorCode, boolean>;

export const relayErrorResponseSchema = z
  .object({
    error: z
      .object({
        code: relayErrorCodeSchema,
        message: z.string(),
        retryable: z.boolean(),
        retryAfterMs: z.number().int().nonnegative().optional(),
      })
      .strict(),
  })
  .strict();
export type RelayErrorResponse = z.infer<typeof relayErrorResponseSchema>;

const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u;
export const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/u;
const MIME_TYPE_PATTERN = /^[\w.+-]+\/[\w.+-]+$/u;
const LABEL_PATTERN = /^[A-Za-z0-9._-]{1,64}$/u;

const relayPayloadTooLargeParams = {
  relayCode: "payload_too_large",
} as const;

export const relayUlidSchema = z.string().regex(ULID_PATTERN);

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function hasSeparatorOrControlChar(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f || code === 0x2f || code === 0x5c) {
      return true;
    }
  }
  return false;
}

function isSafeRelayFilename(value: string): boolean {
  return value !== "." && value !== ".." && !hasSeparatorOrControlChar(value);
}

const BASE64_ALPHABET_CODES = new Uint8Array(128);
for (const char of "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/") {
  BASE64_ALPHABET_CODES[char.charCodeAt(0)] = 1;
}
const BASE64_PAD_CODE = 0x3d;

export function isCanonicalBase64Shape(value: string): boolean {
  const length = value.length;
  if (length % 4 !== 0) {
    return false;
  }
  let dataLength = length;
  if (length > 0 && value.charCodeAt(length - 1) === BASE64_PAD_CODE) {
    dataLength = length - 1;
    if (value.charCodeAt(length - 2) === BASE64_PAD_CODE) {
      dataLength = length - 2;
    }
  }
  for (let index = 0; index < dataLength; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 128 || BASE64_ALPHABET_CODES[code] !== 1) {
      return false;
    }
  }
  return true;
}

export const relayContentBase64Schema = z
  .string()
  .max(RELAY_ATTACHMENT_MAX_BASE64_CHARS)
  .refine(isCanonicalBase64Shape, "contentBase64 must be canonical base64");

export const relayAttachmentSchema = z
  .object({
    filename: z
      .string()
      .min(1)
      .max(RELAY_FILENAME_MAX_CHARS)
      .refine(
        isSafeRelayFilename,
        "filename must not contain separators or control characters",
      ),
    mimeType: z
      .string()
      .max(RELAY_MIME_TYPE_MAX_CHARS)
      .regex(MIME_TYPE_PATTERN),
    contentBase64: relayContentBase64Schema,
    sha256: z.string().regex(SHA256_HEX_PATTERN),
  })
  .strict();
export type RelayAttachment = z.infer<typeof relayAttachmentSchema>;

export const relayTellRequestSchema = z
  .object({
    clientMessageId: relayUlidSchema,
    threadId: z.string().min(1).max(RELAY_THREAD_ID_MAX_CHARS),
    text: z
      .string()
      .min(1)
      .max(RELAY_TEXT_MAX_BYTES)
      .superRefine((value, ctx) => {
        if (utf8ByteLength(value) > RELAY_TEXT_MAX_BYTES) {
          ctx.addIssue({
            code: "custom",
            message: "text exceeds the byte limit",
            params: relayPayloadTooLargeParams,
          });
        }
      }),
    label: z.string().regex(LABEL_PATTERN).optional(),
    attachments: z
      .array(relayAttachmentSchema)
      .max(RELAY_ATTACHMENTS_MAX_COUNT)
      .optional(),
  })
  .strict();
export type RelayTellRequest = z.infer<typeof relayTellRequestSchema>;

export const relayTellResponseSchema = z
  .object({
    status: z.enum(["accepted", "duplicate"]),
    clientMessageId: relayUlidSchema,
    threadId: z.string().min(1),
    queuedMessageId: z.string().min(1),
  })
  .strict();
export type RelayTellResponse = z.infer<typeof relayTellResponseSchema>;

export const relayStatusResponseSchema = z
  .object({
    relayProtocol: z.literal(RELAY_PROTOCOL_VERSION),
    hostId: z.string().min(1),
    connected: z.boolean(),
  })
  .strict();
export type RelayStatusResponse = z.infer<typeof relayStatusResponseSchema>;

export const relayTargetsResponseSchema = z
  .object({
    targets: z.array(
      z
        .object({
          threadId: z.string().min(1),
          createdAt: z.string().min(1),
        })
        .strict(),
    ),
  })
  .strict();
export type RelayTargetsResponse = z.infer<typeof relayTargetsResponseSchema>;

export const relayTargetsRemoveRequestSchema = z
  .object({
    threadId: z.string().min(1).max(RELAY_THREAD_ID_MAX_CHARS).optional(),
  })
  .strict();
export type RelayTargetsRemoveRequest = z.infer<
  typeof relayTargetsRemoveRequestSchema
>;

export const relayTargetsRemoveResponseSchema = z
  .object({
    removed: z.number().int().nonnegative(),
    cancelled: z.number().int().nonnegative(),
  })
  .strict();
export type RelayTargetsRemoveResponse = z.infer<
  typeof relayTargetsRemoveResponseSchema
>;

export function classifyRelayParseError(
  error: z.ZodError,
): "invalid_request" | "payload_too_large" {
  for (const issue of error.issues) {
    if (issue.code === "too_big") {
      return "payload_too_large";
    }
    if (
      issue.code === "custom" &&
      issue.params?.relayCode === relayPayloadTooLargeParams.relayCode
    ) {
      return "payload_too_large";
    }
  }
  return "invalid_request";
}
