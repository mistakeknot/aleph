import type { Readable, Writable } from "node:stream";

export const FRAME_HEADER_BYTES = 4;
export const MAX_FRAME_PAYLOAD_BYTES = 8 * 1024 * 1024;
export const TRANSPORT_READ_AHEAD_BYTES = 64 * 1024;
export const MAX_ENCODE_DEPTH = 32;

const STRING_SLICE_UNITS = 64 * 1024;

export type FrameViolationReason =
  | "frame_too_large"
  | "empty_frame"
  | "truncated_header"
  | "truncated_body";

export interface FrameViolation {
  reason: FrameViolationReason;
  advertisedBytes: number | null;
  receivedBytes: number;
}

export type DecodeEvent =
  | { kind: "frame"; payload: Buffer }
  | { kind: "violation"; violation: FrameViolation };

export class FrameViolationError extends Error {
  readonly violation: FrameViolation;

  constructor(violation: FrameViolation) {
    super(`frame violation: ${violation.reason}`);
    this.name = "FrameViolationError";
    this.violation = violation;
  }
}

export type EncodeFailureReason =
  | "frame_too_large"
  | "empty_frame"
  | "too_deep"
  | "unencodable";

export class FrameEncodeError extends Error {
  readonly reason: EncodeFailureReason;

  constructor(reason: EncodeFailureReason) {
    super(`frame encode failure: ${reason}`);
    this.name = "FrameEncodeError";
    this.reason = reason;
  }
}

export class FrameDecoder {
  private readonly header = Buffer.allocUnsafe(FRAME_HEADER_BYTES);
  private headerFill = 0;
  private body: Buffer | null = null;
  private bodyFill = 0;
  private failure: FrameViolation | null = null;
  private peak = 0;
  private largestChunk = 0;
  private received = 0;
  private frames = 0;

  get violation(): FrameViolation | null {
    return this.failure;
  }

  get bufferedBytes(): number {
    return this.headerFill + this.bodyFill;
  }

  get peakBufferedBytes(): number {
    return this.peak;
  }

  get largestChunkBytes(): number {
    return this.largestChunk;
  }

  get bytesReceived(): number {
    return this.received;
  }

  get framesDecoded(): number {
    return this.frames;
  }

  push(chunk: Uint8Array): DecodeEvent[] {
    if (this.failure !== null) return [];
    this.received += chunk.byteLength;
    if (chunk.byteLength > this.largestChunk) {
      this.largestChunk = chunk.byteLength;
    }
    const events: DecodeEvent[] = [];
    let offset = 0;
    while (offset < chunk.byteLength) {
      if (this.body === null) {
        const take = Math.min(
          FRAME_HEADER_BYTES - this.headerFill,
          chunk.byteLength - offset,
        );
        this.header.set(chunk.subarray(offset, offset + take), this.headerFill);
        this.headerFill += take;
        offset += take;
        this.notePeak();
        if (this.headerFill < FRAME_HEADER_BYTES) break;
        const length = this.header.readUInt32BE(0);
        if (length === 0) {
          events.push(this.fail("empty_frame", length));
          return events;
        }
        if (length > MAX_FRAME_PAYLOAD_BYTES) {
          events.push(this.fail("frame_too_large", length));
          return events;
        }
        this.body = Buffer.allocUnsafe(length);
        this.bodyFill = 0;
        continue;
      }
      const take = Math.min(
        this.body.byteLength - this.bodyFill,
        chunk.byteLength - offset,
      );
      this.body.set(chunk.subarray(offset, offset + take), this.bodyFill);
      this.bodyFill += take;
      offset += take;
      this.notePeak();
      if (this.bodyFill === this.body.byteLength) {
        events.push({ kind: "frame", payload: this.body });
        this.frames += 1;
        this.body = null;
        this.bodyFill = 0;
        this.headerFill = 0;
      }
    }
    return events;
  }

  end(): FrameViolation | null {
    if (this.failure !== null) return this.failure;
    if (this.body !== null) {
      const advertised = this.body.byteLength;
      return this.fail("truncated_body", advertised).violation;
    }
    if (this.headerFill > 0) {
      return this.fail("truncated_header", null).violation;
    }
    return null;
  }

  private notePeak(): void {
    const buffered = this.headerFill + this.bodyFill;
    if (buffered > this.peak) this.peak = buffered;
  }

  private fail(
    reason: FrameViolationReason,
    advertisedBytes: number | null,
  ): DecodeEvent & { kind: "violation" } {
    const violation: FrameViolation = {
      reason,
      advertisedBytes,
      receivedBytes: this.received,
    };
    this.failure = violation;
    this.body = null;
    this.bodyFill = 0;
    this.headerFill = 0;
    return { kind: "violation", violation };
  }
}

export function encodeFrame(payload: Uint8Array): Buffer {
  if (payload.byteLength === 0) throw new FrameEncodeError("empty_frame");
  if (payload.byteLength > MAX_FRAME_PAYLOAD_BYTES) {
    throw new FrameEncodeError("frame_too_large");
  }
  const frame = Buffer.allocUnsafe(FRAME_HEADER_BYTES + payload.byteLength);
  frame.writeUInt32BE(payload.byteLength, 0);
  frame.set(payload, FRAME_HEADER_BYTES);
  return frame;
}

class BoundedJsonWriter {
  private readonly pieces: string[] = [];
  private used = 0;

  constructor(private readonly limit: number) {}

  get bytes(): number {
    return this.used;
  }

  get remaining(): number {
    return this.limit - this.used;
  }

  push(piece: string): void {
    this.used += Buffer.byteLength(piece, "utf8");
    if (this.used > this.limit) throw new FrameEncodeError("frame_too_large");
    this.pieces.push(piece);
  }

  string(value: string): void {
    if (value.length + 2 > this.remaining) {
      throw new FrameEncodeError("frame_too_large");
    }
    this.push('"');
    let start = 0;
    while (start < value.length) {
      let end = Math.min(start + STRING_SLICE_UNITS, value.length);
      if (end < value.length) {
        const last = value.charCodeAt(end - 1);
        if (last >= 0xd800 && last <= 0xdbff) end += 1;
      }
      const escaped = JSON.stringify(value.slice(start, end));
      this.push(escaped.slice(1, -1));
      start = end;
    }
    this.push('"');
  }

  value(input: unknown, depth: number): void {
    if (input === null) return this.push("null");
    switch (typeof input) {
      case "boolean":
        return this.push(input ? "true" : "false");
      case "number":
        if (!Number.isFinite(input)) throw new FrameEncodeError("unencodable");
        return this.push(JSON.stringify(input));
      case "string":
        return this.string(input);
      case "object":
        break;
      default:
        throw new FrameEncodeError("unencodable");
    }
    if (depth >= MAX_ENCODE_DEPTH) throw new FrameEncodeError("too_deep");
    if (Array.isArray(input)) {
      this.push("[");
      for (let index = 0; index < input.length; index += 1) {
        if (index > 0) this.push(",");
        const item: unknown = input[index];
        if (item === undefined) this.push("null");
        else this.value(item, depth + 1);
      }
      this.push("]");
      return;
    }
    this.push("{");
    let first = true;
    for (const key of Object.keys(input)) {
      const item: unknown = (input as Record<string, unknown>)[key];
      if (item === undefined) continue;
      if (!first) this.push(",");
      first = false;
      this.string(key);
      this.push(":");
      this.value(item, depth + 1);
    }
    this.push("}");
  }

  frame(): Buffer {
    if (this.used === 0) throw new FrameEncodeError("empty_frame");
    const frame = Buffer.allocUnsafe(FRAME_HEADER_BYTES + this.used);
    frame.writeUInt32BE(this.used, 0);
    let offset = FRAME_HEADER_BYTES;
    for (const piece of this.pieces) {
      offset += frame.write(piece, offset, "utf8");
    }
    return frame;
  }
}

export function encodeJsonFrame(value: unknown): Buffer {
  const writer = new BoundedJsonWriter(MAX_FRAME_PAYLOAD_BYTES);
  writer.value(value, 0);
  return writer.frame();
}

export function decodeJsonPayload(payload: Uint8Array): unknown {
  return JSON.parse(Buffer.from(payload).toString("utf8"));
}

export async function* readFrames(stream: Readable): AsyncGenerator<Buffer> {
  const decoder = new FrameDecoder();
  for await (const chunk of stream) {
    for (const event of decoder.push(chunk as Uint8Array)) {
      if (event.kind === "violation") {
        throw new FrameViolationError(event.violation);
      }
      yield event.payload;
    }
  }
  const trailing = decoder.end();
  if (trailing !== null) throw new FrameViolationError(trailing);
}

export function writeFrame(stream: Writable, frame: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(frame, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
