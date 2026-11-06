import type { Readable, Writable } from "node:stream";

import { readPage } from "../adapters/claude.js";
import { readCodexPage } from "../adapters/codex.js";
import type {
  JsonlSource,
  PageBudget,
  SourcePage,
} from "../adapters/jsonl-page.js";
import {
  FrameDecoder,
  FrameEncodeError,
  encodeJsonFrame,
} from "../ipc/frame.js";
import {
  parseParserRequest,
  type ParserErrorCode,
  type ParserProvider,
  type ParserResponse,
} from "./protocol.js";

export type PageReader = (
  source: JsonlSource,
  cursor: string | null,
  budget?: PageBudget,
) => Promise<SourcePage>;

export type ParserReaders = Record<ParserProvider, PageReader>;

export const DEFAULT_PARSER_READERS: ParserReaders = {
  claude: (source, cursor, budget) => readPage(source, cursor, budget),
  codex: (source, cursor, budget) => readCodexPage(source, cursor, budget),
};

export interface ParserChannel {
  input: Readable;
  output: Writable;
}

export const PARSER_BAD_REQUEST_EXIT = 2;

function write(output: Writable, bytes: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    output.write(bytes, (error) => (error ? reject(error) : resolve()));
  });
}

function errorCode(error: unknown): ParserErrorCode {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (
    code === "EACCES" ||
    code === "EPERM" ||
    code === "EISDIR" ||
    code === "ENOENT" ||
    code === "EIO"
  ) {
    return "unreadable";
  }
  return "failed";
}

async function respond(
  output: Writable,
  id: number,
  response: ParserResponse,
): Promise<void> {
  try {
    await write(output, encodeJsonFrame(response));
  } catch (error) {
    if (!(error instanceof FrameEncodeError)) throw error;
    await write(
      output,
      encodeJsonFrame({
        t: "error",
        id,
        code: "page_too_large",
        message: error.reason,
      } satisfies ParserResponse),
    );
  }
}

export async function runParserChild(
  channel: ParserChannel,
  readers: ParserReaders = DEFAULT_PARSER_READERS,
): Promise<number> {
  const decoder = new FrameDecoder();
  await write(channel.output, encodeJsonFrame({ t: "ready" }));
  for await (const chunk of channel.input) {
    for (const event of decoder.push(chunk as Uint8Array)) {
      if (event.kind === "violation") return PARSER_BAD_REQUEST_EXIT;
      const request = parseParserRequest(event.payload);
      if (request === null) return PARSER_BAD_REQUEST_EXIT;
      const { source } = request;
      const jsonl: JsonlSource = {
        ref: source.ref,
        path: source.path,
        sessionId: source.sessionId ?? null,
        agentId: source.agentId ?? null,
      };
      try {
        const page = await readers[source.provider](
          jsonl,
          request.cursor,
          request.budget,
        );
        await respond(channel.output, request.id, {
          t: "page",
          id: request.id,
          page,
        });
      } catch (error) {
        if (error instanceof FrameEncodeError) throw error;
        await respond(channel.output, request.id, {
          t: "error",
          id: request.id,
          code: errorCode(error),
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  return 0;
}
