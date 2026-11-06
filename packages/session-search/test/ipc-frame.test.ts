import { Readable } from "node:stream";

import { describe, expect, it } from "vitest";

import {
  decodeJsonPayload,
  encodeFrame,
  encodeJsonFrame,
  FRAME_HEADER_BYTES,
  FrameDecoder,
  FrameEncodeError,
  FrameViolationError,
  MAX_ENCODE_DEPTH,
  MAX_FRAME_PAYLOAD_BYTES,
  readFrames,
  type DecodeEvent,
} from "../src/index.js";

function header(length: number): Buffer {
  const buffer = Buffer.alloc(FRAME_HEADER_BYTES);
  buffer.writeUInt32BE(length, 0);
  return buffer;
}

function frames(events: DecodeEvent[]): Buffer[] {
  return events.flatMap((event) =>
    event.kind === "frame" ? [event.payload] : [],
  );
}

function feedByByte(decoder: FrameDecoder, bytes: Buffer): DecodeEvent[] {
  const events: DecodeEvent[] = [];
  for (let index = 0; index < bytes.byteLength; index += 1) {
    events.push(...decoder.push(bytes.subarray(index, index + 1)));
  }
  return events;
}

function encodedFailure(run: () => unknown): string | null {
  try {
    run();
  } catch (error) {
    return error instanceof FrameEncodeError ? error.reason : String(error);
  }
  return null;
}

describe("frame limits", () => {
  it("declares an 8 MiB payload limit with a 4 byte header", () => {
    expect(MAX_FRAME_PAYLOAD_BYTES).toBe(8 * 1024 * 1024);
    expect(FRAME_HEADER_BYTES).toBe(4);
  });

  it("writes the length as four unsigned big-endian bytes", () => {
    const frame = encodeFrame(Buffer.alloc(0x010203, 1));
    expect([...frame.subarray(0, 4)]).toEqual([0, 1, 2, 3]);
    expect(frame.byteLength).toBe(4 + 0x010203);
  });

  it("accepts a payload of exactly 8 MiB in both directions", () => {
    const payload = Buffer.alloc(MAX_FRAME_PAYLOAD_BYTES, 0x41);
    const decoder = new FrameDecoder();
    const events = decoder.push(encodeFrame(payload));
    expect(events).toHaveLength(1);
    expect(frames(events)[0]?.byteLength).toBe(MAX_FRAME_PAYLOAD_BYTES);
    expect(decoder.violation).toBeNull();
    expect(decoder.end()).toBeNull();
  });

  it("rejects 8 MiB plus one byte in the encoder", () => {
    expect(
      encodedFailure(() =>
        encodeFrame(Buffer.alloc(MAX_FRAME_PAYLOAD_BYTES + 1)),
      ),
    ).toBe("frame_too_large");
  });

  it("rejects an advertised 8 MiB plus one byte at the header without allocating a body", () => {
    const decoder = new FrameDecoder();
    const events = decoder.push(header(MAX_FRAME_PAYLOAD_BYTES + 1));
    expect(events).toEqual([
      {
        kind: "violation",
        violation: {
          reason: "frame_too_large",
          advertisedBytes: MAX_FRAME_PAYLOAD_BYTES + 1,
          receivedBytes: 4,
        },
      },
    ]);
    expect(decoder.bufferedBytes).toBe(0);
    expect(decoder.peakBufferedBytes).toBe(FRAME_HEADER_BYTES);
  });

  it("rejects an advertised 64 MiB frame at the header and ignores the body that follows", () => {
    const decoder = new FrameDecoder();
    const chunk = Buffer.concat([
      header(64 * 1024 * 1024),
      Buffer.alloc(65_536),
    ]);
    const events = decoder.push(chunk);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "violation",
      violation: {
        reason: "frame_too_large",
        advertisedBytes: 64 * 1024 * 1024,
      },
    });
    expect(decoder.peakBufferedBytes).toBe(FRAME_HEADER_BYTES);
    expect(decoder.bufferedBytes).toBe(0);
    expect(decoder.push(Buffer.alloc(65_536))).toEqual([]);
    expect(decoder.framesDecoded).toBe(0);
  });

  it("rejects the largest unsigned advertised length", () => {
    const decoder = new FrameDecoder();
    const events = decoder.push(Buffer.from([0xff, 0xff, 0xff, 0xff]));
    expect(events[0]).toMatchObject({
      violation: { reason: "frame_too_large", advertisedBytes: 0xffffffff },
    });
  });

  it("rejects a zero-length frame in both directions", () => {
    const decoder = new FrameDecoder();
    expect(decoder.push(header(0))[0]).toMatchObject({
      violation: { reason: "empty_frame", advertisedBytes: 0 },
    });
    expect(encodedFailure(() => encodeFrame(Buffer.alloc(0)))).toBe(
      "empty_frame",
    );
  });
});

describe("decoding", () => {
  it("reassembles a header split across single-byte chunks", () => {
    const decoder = new FrameDecoder();
    const events = feedByByte(decoder, encodeFrame(Buffer.from("fragmented")));
    expect(frames(events).map(String)).toEqual(["fragmented"]);
    expect(decoder.peakBufferedBytes).toBe(4 + "fragmented".length);
  });

  it("holds a partial header until the remaining bytes arrive", () => {
    const decoder = new FrameDecoder();
    const frame = encodeFrame(Buffer.from("abc"));
    expect(decoder.push(frame.subarray(0, 2))).toEqual([]);
    expect(decoder.bufferedBytes).toBe(2);
    expect(decoder.push(frame.subarray(2, 4))).toEqual([]);
    expect(frames(decoder.push(frame.subarray(4))).map(String)).toEqual([
      "abc",
    ]);
    expect(decoder.bufferedBytes).toBe(0);
  });

  it("decodes several frames delivered in one chunk", () => {
    const decoder = new FrameDecoder();
    const chunk = Buffer.concat(
      ["one", "two", "three"].map((text) => encodeFrame(Buffer.from(text))),
    );
    expect(frames(decoder.push(chunk)).map(String)).toEqual([
      "one",
      "two",
      "three",
    ]);
    expect(decoder.framesDecoded).toBe(3);
  });

  it("decodes a frame that straddles two chunks followed by the next header", () => {
    const decoder = new FrameDecoder();
    const first = encodeFrame(Buffer.from("alpha"));
    const second = encodeFrame(Buffer.from("beta"));
    const joined = Buffer.concat([first, second]);
    const cut = first.byteLength - 2;
    const events = [
      ...decoder.push(joined.subarray(0, cut)),
      ...decoder.push(joined.subarray(cut, cut + 3)),
      ...decoder.push(joined.subarray(cut + 3)),
    ];
    expect(frames(events).map(String)).toEqual(["alpha", "beta"]);
  });

  it("returns frames that own their bytes", () => {
    const decoder = new FrameDecoder();
    const [first] = frames(decoder.push(encodeFrame(Buffer.from("first"))));
    decoder.push(encodeFrame(Buffer.from("other")));
    expect(first?.toString()).toBe("first");
  });

  it("reports a truncated body at end of input", () => {
    const decoder = new FrameDecoder();
    decoder.push(Buffer.concat([header(100), Buffer.alloc(10)]));
    expect(decoder.end()).toEqual({
      reason: "truncated_body",
      advertisedBytes: 100,
      receivedBytes: 14,
    });
  });

  it("reports a truncated header at end of input", () => {
    const decoder = new FrameDecoder();
    decoder.push(Buffer.from([0, 0]));
    expect(decoder.end()).toEqual({
      reason: "truncated_header",
      advertisedBytes: null,
      receivedBytes: 2,
    });
  });

  it("reports nothing for a clean end of input", () => {
    const decoder = new FrameDecoder();
    decoder.push(encodeFrame(Buffer.from("done")));
    expect(decoder.end()).toBeNull();
  });

  it("stops decoding after the first violation", () => {
    const decoder = new FrameDecoder();
    const chunk = Buffer.concat([
      encodeFrame(Buffer.from("good")),
      header(MAX_FRAME_PAYLOAD_BYTES + 1),
      encodeFrame(Buffer.from("never")),
    ]);
    const events = decoder.push(chunk);
    expect(events.map((event) => event.kind)).toEqual(["frame", "violation"]);
    expect(decoder.push(encodeFrame(Buffer.from("later")))).toEqual([]);
    expect(decoder.framesDecoded).toBe(1);
  });

  it("never buffers more than the header plus the declared body", () => {
    const decoder = new FrameDecoder();
    const body = Buffer.alloc(300_000, 7);
    const bytes = Buffer.concat([header(body.byteLength), body]);
    for (let offset = 0; offset < bytes.byteLength; offset += 65_536) {
      decoder.push(bytes.subarray(offset, offset + 65_536));
    }
    expect(decoder.peakBufferedBytes).toBe(4 + body.byteLength);
    expect(decoder.largestChunkBytes).toBe(65_536);
  });

  it("decodes a stream through readFrames and throws on violations", async () => {
    const good = Readable.from([
      Buffer.concat([
        encodeFrame(Buffer.from("a")),
        encodeFrame(Buffer.from("b")),
      ]),
    ]);
    const seen: string[] = [];
    for await (const payload of readFrames(good)) seen.push(payload.toString());
    expect(seen).toEqual(["a", "b"]);

    const bad = Readable.from([header(MAX_FRAME_PAYLOAD_BYTES + 1)]);
    await expect(async () => {
      for await (const unused of readFrames(bad)) void unused;
    }).rejects.toBeInstanceOf(FrameViolationError);

    const truncated = Readable.from([
      Buffer.concat([header(10), Buffer.alloc(3)]),
    ]);
    await expect(async () => {
      for await (const unused of readFrames(truncated)) void unused;
    }).rejects.toMatchObject({ violation: { reason: "truncated_body" } });
  });
});

describe("bounded JSON encoding", () => {
  it("round-trips structured values", () => {
    const value = {
      kind: "page",
      numbers: [1, -2.5, 3e20, 0],
      flags: [true, false, null],
      nested: { a: "x", b: ["y", { c: "z" }] },
      text: 'quote " backslash \\ newline \n tab \t unicode é   \u{1f600}',
    };
    const frame = encodeJsonFrame(value);
    const decoder = new FrameDecoder();
    const [payload] = frames(decoder.push(frame));
    expect(decodeJsonPayload(payload ?? Buffer.alloc(0))).toEqual(value);
    expect(payload?.toString("utf8")).toBe(JSON.stringify(value));
  });

  it("matches JSON.stringify for undefined members and array holes", () => {
    const value = { keep: 1, drop: undefined, list: [1, undefined, 3] };
    const frame = encodeJsonFrame(value);
    expect(frame.subarray(4).toString()).toBe(JSON.stringify(value));
  });

  it("accepts a document whose encoded size is exactly 8 MiB", () => {
    const overhead = JSON.stringify({ t: "" }).length;
    const text = "a".repeat(MAX_FRAME_PAYLOAD_BYTES - overhead);
    const frame = encodeJsonFrame({ t: text });
    expect(frame.byteLength).toBe(4 + MAX_FRAME_PAYLOAD_BYTES);
    expect(frame.readUInt32BE(0)).toBe(MAX_FRAME_PAYLOAD_BYTES);
  });

  it("rejects a document that encodes to 8 MiB plus one byte", () => {
    const overhead = JSON.stringify({ t: "" }).length;
    const text = "a".repeat(MAX_FRAME_PAYLOAD_BYTES - overhead + 1);
    expect(encodedFailure(() => encodeJsonFrame({ t: text }))).toBe(
      "frame_too_large",
    );
  });

  it("counts escaped bytes: 4 MiB of control characters cannot fit", () => {
    const text = "\u0001".repeat(4 * 1024 * 1024);
    expect(text.length).toBe(4 * 1024 * 1024);
    expect(encodedFailure(() => encodeJsonFrame({ t: text }))).toBe(
      "frame_too_large",
    );
  });

  it("counts multi-byte UTF-8 rather than string length", () => {
    const text = "é".repeat(MAX_FRAME_PAYLOAD_BYTES / 2);
    expect(encodedFailure(() => encodeJsonFrame(text))).toBe("frame_too_large");
    const fits = "é".repeat(MAX_FRAME_PAYLOAD_BYTES / 2 - 1);
    expect(encodeJsonFrame(fits).readUInt32BE(0)).toBe(MAX_FRAME_PAYLOAD_BYTES);
  });

  it("keeps surrogate pairs whole across slice boundaries", () => {
    const text = `${"a".repeat(65_535)}\u{1f600}${"b".repeat(10)}`;
    const frame = encodeJsonFrame(text);
    expect(decodeJsonPayload(frame.subarray(4))).toBe(text);
  });

  it("stops while walking a huge array instead of materializing it", () => {
    const rows = Array.from({ length: 2_000_000 }, () => "0123456789");
    expect(encodedFailure(() => encodeJsonFrame(rows))).toBe("frame_too_large");
  });

  it("refuses values that JSON cannot represent", () => {
    expect(encodedFailure(() => encodeJsonFrame(Number.NaN))).toBe(
      "unencodable",
    );
    expect(encodedFailure(() => encodeJsonFrame(Infinity))).toBe("unencodable");
    expect(encodedFailure(() => encodeJsonFrame(() => 1))).toBe("unencodable");
    expect(encodedFailure(() => encodeJsonFrame(1n))).toBe("unencodable");
    expect(encodedFailure(() => encodeJsonFrame(undefined))).toBe(
      "unencodable",
    );
  });

  it("limits nesting depth", () => {
    let deep: unknown = "leaf";
    for (let level = 0; level < MAX_ENCODE_DEPTH + 1; level += 1) deep = [deep];
    expect(encodedFailure(() => encodeJsonFrame(deep))).toBe("too_deep");
    let allowed: unknown = "leaf";
    for (let level = 0; level < MAX_ENCODE_DEPTH; level += 1)
      allowed = [allowed];
    expect(encodeJsonFrame(allowed).byteLength).toBeGreaterThan(4);
  });
});
