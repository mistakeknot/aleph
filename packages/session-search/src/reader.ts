import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import { createZstdDecompress } from "node:zlib";

import { parseJsonlLine } from "./contracts.js";

export interface ReadJsonlOptions {
  maxLogicalBytes?: number;
}

export interface JsonlReadResult {
  records: unknown[];
  malformedLines: number;
  logicalBytes: number;
  compressed: boolean;
  truncated: boolean;
}

const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];

async function isZstdFile(path: string): Promise<boolean> {
  const handle = await open(path, "r");
  try {
    const header = Buffer.alloc(ZSTD_MAGIC.length);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    return (
      bytesRead === ZSTD_MAGIC.length &&
      ZSTD_MAGIC.every((byte, index) => header[index] === byte)
    );
  } finally {
    await handle.close();
  }
}

export async function readJsonlFile(
  path: string,
  options: ReadJsonlOptions = {},
): Promise<JsonlReadResult> {
  const compressed = await isZstdFile(path);
  const file = createReadStream(path);
  const stream: AsyncIterable<Buffer | string> = compressed
    ? file.pipe(createZstdDecompress())
    : file;
  const maxLogicalBytes = options.maxLogicalBytes ?? Number.POSITIVE_INFINITY;
  const decoder = new StringDecoder("utf8");
  const records: unknown[] = [];
  let malformedLines = 0;
  let logicalBytes = 0;
  let truncated = false;
  let pending = "";

  const consumeLine = (rawLine: string): void => {
    const line = rawLine.trim();
    if (line.length === 0) {
      return;
    }
    const parsed = parseJsonlLine(line);
    if (parsed.ok) {
      records.push(parsed.value);
    } else {
      malformedLines += 1;
    }
  };

  try {
    for await (const chunk of stream) {
      const buffer =
        typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      const remaining = maxLogicalBytes - logicalBytes;
      const usable =
        buffer.length > remaining
          ? buffer.subarray(0, Math.max(remaining, 0))
          : buffer;
      logicalBytes += usable.length;
      pending += decoder.write(usable);
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        consumeLine(line);
      }
      if (usable.length < buffer.length) {
        truncated = true;
        break;
      }
    }
  } finally {
    file.destroy();
  }

  if (!truncated) {
    pending += decoder.end();
    consumeLine(pending);
  } else if (pending.length > 0) {
    malformedLines += pending.trim().length > 0 ? 1 : 0;
  }

  return { records, malformedLines, logicalBytes, compressed, truncated };
}
