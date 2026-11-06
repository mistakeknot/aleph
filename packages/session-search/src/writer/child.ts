import type { Readable, Writable } from "node:stream";

import {
  FrameDecoder,
  FrameEncodeError,
  encodeJsonFrame,
} from "../ipc/frame.js";
import type { SessionSearchStore } from "../storage.js";
import {
  parseWriterRequest,
  type WriterRequest,
  type WriterResponse,
} from "./protocol.js";

export interface WriterChannel {
  input: Readable;
  output: Writable;
}

export const WRITER_BAD_REQUEST_EXIT = 2;

export interface WriterChildHooks {
  beforeResponse?: (request: WriterRequest) => void | Promise<void>;
}

function write(output: Writable, bytes: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    output.write(bytes, (error) => (error ? reject(error) : resolve()));
  });
}

function handle(
  store: SessionSearchStore,
  request: WriterRequest,
): WriterResponse {
  switch (request.t) {
    case "sync":
      store.syncFences(request.fences);
      return { t: "done", id: request.id };
    case "fence":
      store.setFence(request.entry);
      return { t: "done", id: request.id };
    case "unfence":
      store.clearFence(request.key);
      return { t: "done", id: request.id };
    case "commit": {
      const options =
        request.token === null ? {} : { fenceToken: request.token };
      const result = store.commitBatch(
        request.batch,
        request.cursor,
        undefined,
        options,
      );
      return { t: "commit", id: request.id, result };
    }
    case "cursor":
      return {
        t: "cursor",
        id: request.id,
        cursor: store.getCursor(request.source),
      };
    case "remove": {
      const rows = store.removeSource(
        request.key,
        request.chunkRows === undefined
          ? {}
          : { chunkRows: request.chunkRows },
      );
      return { t: "removed", id: request.id, rows };
    }
    case "pressure": {
      const { state } = store.recordMemoryPressure({
        source: request.source,
        mergePossible: request.mergePossible,
      });
      return { t: "pressure", id: request.id, state };
    }
    case "retry": {
      const outcome = store.beginControlledRetry({
        mitigation: request.mitigation,
      });
      return {
        t: "retry",
        id: request.id,
        ok: outcome.ok,
        reason: outcome.ok ? null : outcome.reason,
      };
    }
    case "state":
      return {
        t: "state",
        id: request.id,
        state: {
          pressure: store.memoryPressure(),
          epoch: store.epoch(),
          suspended: store.suspended,
        },
      };
  }
}

async function respond(
  output: Writable,
  response: WriterResponse,
): Promise<void> {
  try {
    await write(output, encodeJsonFrame(response));
  } catch (error) {
    if (!(error instanceof FrameEncodeError)) throw error;
    if (response.t === "commit") {
      await write(
        output,
        encodeJsonFrame({
          ...response,
          result: { ...response.result, entries: [] },
        } satisfies WriterResponse),
      );
      return;
    }
    await write(
      output,
      encodeJsonFrame({
        t: "error",
        id: "id" in response ? response.id : 0,
        message: error.reason,
      } satisfies WriterResponse),
    );
  }
}

export async function runWriterChild(
  channel: WriterChannel,
  store: SessionSearchStore,
  hooks: WriterChildHooks = {},
): Promise<number> {
  const decoder = new FrameDecoder();
  await write(channel.output, encodeJsonFrame({ t: "ready" }));
  for await (const chunk of channel.input) {
    for (const event of decoder.push(chunk as Uint8Array)) {
      if (event.kind === "violation") return WRITER_BAD_REQUEST_EXIT;
      const request = parseWriterRequest(event.payload);
      if (request === null) return WRITER_BAD_REQUEST_EXIT;
      let response: WriterResponse;
      try {
        response = handle(store, request);
      } catch (error) {
        response = {
          t: "error",
          id: request.id,
          message: error instanceof Error ? error.message : String(error),
        };
      }
      await hooks.beforeResponse?.(request);
      await respond(channel.output, response);
    }
  }
  return 0;
}
