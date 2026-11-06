import type { ChunkSource } from "../../src/streaming-reader.js";

export type Segment =
  | { kind: "bytes"; bytes: Buffer }
  | { kind: "fill"; byte: number; length: number };

export function text(value: string): Segment {
  return { kind: "bytes", bytes: Buffer.from(value, "utf8") };
}

export function raw(...bytes: number[]): Segment {
  return { kind: "bytes", bytes: Buffer.from(bytes) };
}

export function fill(byte: number, length: number): Segment {
  return { kind: "fill", byte, length };
}

export interface CountingSource extends ChunkSource {
  reads: number;
  bytesServed: number;
  largestRead: number;
  readonly total: number;
}

export function segmentSource(segments: Segment[]): CountingSource {
  const starts: number[] = [];
  let total = 0;
  for (const segment of segments) {
    starts.push(total);
    total += segment.kind === "bytes" ? segment.bytes.length : segment.length;
  }
  const source: CountingSource = {
    reads: 0,
    bytesServed: 0,
    largestRead: 0,
    total,
    async read(position, into) {
      source.reads += 1;
      if (position >= total) return 0;
      const want = Math.min(into.byteLength, total - position);
      let written = 0;
      for (
        let index = 0;
        index < segments.length && written < want;
        index += 1
      ) {
        const segment = segments[index]!;
        const length =
          segment.kind === "bytes" ? segment.bytes.length : segment.length;
        const begin = starts[index]!;
        const end = begin + length;
        const at = position + written;
        if (at >= end) continue;
        const take = Math.min(end - at, want - written);
        if (segment.kind === "bytes") {
          segment.bytes.copy(into, written, at - begin, at - begin + take);
        } else {
          into.fill(segment.byte, written, written + take);
        }
        written += take;
      }
      source.bytesServed += written;
      source.largestRead = Math.max(source.largestRead, written);
      return written;
    },
  };
  return source;
}

export function bufferSource(data: Buffer): CountingSource {
  return segmentSource([{ kind: "bytes", bytes: data }]);
}
