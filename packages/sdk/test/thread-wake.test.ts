import { describe, expect, it, vi } from "vitest";
import { createBbSdk } from "../src/core.js";
import type { FetchImplementation } from "../src/response.js";
import { createHttpTransport } from "../src/transport-http.js";

interface RecordedRequest {
  url: string;
  method: string | undefined;
  body: unknown;
}

function createRecordingSdk() {
  const requests: RecordedRequest[] = [];
  const fetch = vi.fn<FetchImplementation>(async (input, init) => {
    requests.push({
      url: String(input),
      method: init?.method,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    return Response.json({ ok: true });
  });
  const sdk = createBbSdk({
    transport: createHttpTransport({
      baseUrl: "https://example.test",
      fetch,
      runtime: "node",
    }),
  });
  return { fetch, requests, sdk };
}

describe("wake transport", () => {
  it("serializes send, spawn and fork attribution", async () => {
    const { requests, sdk } = createRecordingSdk();
    const wake = { wakeCause: "card_pick" as const, wakeRef: "operation-1" };
    await sdk.threads.send({
      threadId: "thread",
      input: [{ type: "text", text: "followup", mentions: [] }],
      mode: "auto",
      ...wake,
    });
    await sdk.threads.spawn({
      projectId: "project",
      prompt: "start",
      environment: {
        type: "host",
        hostId: "host",
        workspace: { type: "unmanaged", path: null },
      },
      ...wake,
    });
    await sdk.threads.fork({ sourceThreadId: "thread", ...wake });
    await sdk.threads.queuedMessages.create({
      threadId: "thread",
      input: [{ type: "text", text: "queued", mentions: [] }],
      ...wake,
    });
    expect(requests).toHaveLength(4);
    for (const request of requests) expect(request.body).toMatchObject(wake);
  });
});
