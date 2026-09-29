import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
  RELAY_ATTACHMENT_MAX_BASE64_CHARS,
  RELAY_ATTACHMENT_MAX_BYTES,
  RELAY_ATTACHMENTS_MAX_COUNT,
  RELAY_ATTACHMENTS_TOTAL_MAX_BASE64_CHARS,
  RELAY_ATTACHMENTS_TOTAL_MAX_BYTES,
  SHA256_HEX_PATTERN,
  isCanonicalBase64Shape,
  type RelayAttachment,
} from "./relay.js";

export interface RelayDecodedAttachment {
  bytes: Buffer;
  sizeBytes: number;
}

export type RelayDecodeResult =
  | { ok: true; attachments: RelayDecodedAttachment[] }
  | {
      ok: false;
      code: "invalid_request" | "payload_too_large";
      message: string;
    };

function decodeFailure(
  code: "invalid_request" | "payload_too_large",
  message: string,
): RelayDecodeResult {
  return { ok: false, code, message };
}

export function decodeRelayAttachments(
  attachments: readonly Pick<RelayAttachment, "contentBase64" | "sha256">[],
): RelayDecodeResult {
  if (attachments.length > RELAY_ATTACHMENTS_MAX_COUNT) {
    return decodeFailure("payload_too_large", "too many attachments");
  }
  let totalChars = 0;
  for (const attachment of attachments) {
    const chars = attachment.contentBase64.length;
    if (chars > RELAY_ATTACHMENT_MAX_BASE64_CHARS) {
      return decodeFailure("payload_too_large", "attachment is too large");
    }
    totalChars += chars;
  }
  if (totalChars > RELAY_ATTACHMENTS_TOTAL_MAX_BASE64_CHARS) {
    return decodeFailure("payload_too_large", "attachments are too large");
  }
  for (const attachment of attachments) {
    if (!isCanonicalBase64Shape(attachment.contentBase64)) {
      return decodeFailure(
        "invalid_request",
        "contentBase64 must be canonical base64",
      );
    }
    if (!SHA256_HEX_PATTERN.test(attachment.sha256)) {
      return decodeFailure("invalid_request", "sha256 must be lowercase hex");
    }
  }

  const decoded: RelayDecodedAttachment[] = [];
  let totalBytes = 0;
  for (const attachment of attachments) {
    const bytes = Buffer.from(attachment.contentBase64, "base64");
    if (bytes.toString("base64") !== attachment.contentBase64) {
      return decodeFailure(
        "invalid_request",
        "contentBase64 is not the canonical encoding of its bytes",
      );
    }
    if (bytes.length > RELAY_ATTACHMENT_MAX_BYTES) {
      return decodeFailure("payload_too_large", "attachment is too large");
    }
    totalBytes += bytes.length;
    if (totalBytes > RELAY_ATTACHMENTS_TOTAL_MAX_BYTES) {
      return decodeFailure("payload_too_large", "attachments are too large");
    }
    if (
      createHash("sha256").update(bytes).digest("hex") !== attachment.sha256
    ) {
      return decodeFailure("invalid_request", "sha256 does not match content");
    }
    decoded.push({ bytes, sizeBytes: bytes.length });
  }
  return { ok: true, attachments: decoded };
}
