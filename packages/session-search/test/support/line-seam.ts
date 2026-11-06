import {
  oversizedDedupeKey,
  type OversizedPlaceholder,
} from "../../src/admission.js";

export type SeamItem =
  | { kind: "line"; text: string; startOffset: number; endOffset: number }
  | { kind: "placeholder"; placeholder: OversizedPlaceholder };

export interface SeamStats {
  peakRetainedBytes: number;
  chunks: number;
}

export async function* splitLines(
  chunks: AsyncIterable<Buffer>,
  generation: number,
  maxLineBytes: number,
  stats: SeamStats,
): AsyncGenerator<SeamItem> {
  let retained: Buffer[] = [];
  let retainedBytes = 0;
  let lineStart = 0;
  let consumed = 0;
  let skipping = false;
  let skippedBytes = 0;

  const note = (): void => {
    stats.peakRetainedBytes = Math.max(stats.peakRetainedBytes, retainedBytes);
  };

  const finishLine = (endOffset: number): SeamItem | null => {
    if (skipping) {
      const placeholder: OversizedPlaceholder = {
        kind: "oversized_record",
        dedupeKey: oversizedDedupeKey(generation, lineStart),
        startOffset: lineStart,
        endOffset,
        byteLength: endOffset - lineStart,
        reason: "record_too_large",
      };
      skipping = false;
      skippedBytes = 0;
      retained = [];
      retainedBytes = 0;
      return { kind: "placeholder", placeholder };
    }
    const text = Buffer.concat(retained).toString("utf8");
    retained = [];
    retainedBytes = 0;
    return text.length === 0
      ? null
      : { kind: "line", text, startOffset: lineStart, endOffset };
  };

  for await (const chunk of chunks) {
    stats.chunks += 1;
    let position = 0;
    while (position < chunk.length) {
      const newline = chunk.indexOf(0x0a, position);
      const end = newline === -1 ? chunk.length : newline;
      const piece = end - position;
      if (!skipping && retainedBytes + piece > maxLineBytes) {
        skipping = true;
        skippedBytes = retainedBytes;
        retained = [];
        retainedBytes = 0;
      }
      if (skipping) {
        skippedBytes += piece;
      } else if (piece > 0) {
        retained.push(Buffer.from(chunk.subarray(position, end)));
        retainedBytes += piece;
        note();
      }
      if (newline === -1) {
        position = chunk.length;
      } else {
        const item = finishLine(consumed + newline);
        if (item !== null) yield item;
        lineStart = consumed + newline + 1;
        position = newline + 1;
      }
    }
    consumed += chunk.length;
  }
  if (skipping || retainedBytes > 0) {
    const item = finishLine(consumed);
    if (item !== null) yield item;
  }
}

export async function* chunked(
  total: Buffer,
  chunkBytes: number,
): AsyncGenerator<Buffer> {
  for (let at = 0; at < total.length; at += chunkBytes) {
    yield Buffer.from(total.subarray(at, Math.min(at + chunkBytes, total.length)));
  }
}
