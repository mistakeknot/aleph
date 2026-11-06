import { setTimeout as sleep } from "node:timers/promises";

import { openParentChannel } from "../../src/ipc/framed-child.js";
import {
  DEFAULT_PARSER_READERS,
  runParserChild,
  type PageReader,
  type ParserReaders,
} from "../../src/parser/child.js";

const MIB = 1024 * 1024;
const channel = openParentChannel();
channel.output.on("error", () => process.exit(0));

function header(length: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(length, 0);
  return buffer;
}

function wrap(reader: PageReader): PageReader {
  return async (source, cursor, budget) => {
    const path = source.path;
    if (path.endsWith(".stall.jsonl")) {
      await sleep(600_000);
    }
    if (path.endsWith(".crash.jsonl")) {
      process.exit(70);
    }
    if (path.endsWith(".violate.jsonl")) {
      channel.output.write(header(64 * MIB));
      await sleep(600_000);
    }
    if (path.endsWith(".bloat.jsonl")) {
      const held: Buffer[] = [];
      for (let index = 0; index < 64; index += 1) {
        held.push(Buffer.alloc(8 * MIB, index + 1));
        await sleep(5);
      }
      await sleep(600_000);
    }
    if (path.endsWith(".huge.jsonl")) {
      const page = await reader(source, cursor, budget);
      if (page.status === "page") {
        return {
          ...page,
          batch: {
            ...page.batch,
            records: [
              ...page.batch.records,
              { ...page.batch.records[0]!, text: "x".repeat(9 * MIB) },
            ],
          },
        };
      }
      return page;
    }
    return reader(source, cursor, budget);
  };
}

const readers: ParserReaders = {
  claude: wrap(DEFAULT_PARSER_READERS.claude),
  codex: wrap(DEFAULT_PARSER_READERS.codex),
};

runParserChild(channel, readers).then(
  (code) => process.exit(code),
  () => process.exit(1),
);
