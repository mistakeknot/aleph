import { describe, expect, it } from "vitest";
import type { JsonValue } from "@bb/domain";
import { createBbSdk } from "../src/core.js";
import { createHttpTransport } from "../src/transport-http.js";
import type { FetchImplementation } from "../src/response.js";

interface CapturedRequest {
  bodyText: string | undefined;
  headers: Record<string, string>;
  method: string;
  url: string;
}

interface QueuedResponse {
  rawBody?: string;
  body?: JsonValue;
  status?: number;
}

const HOLDER_TITLE = "Masaq'  |\tops　channel";

const HELD_STATE = {
  role: "ruler",
  threadId: "thr_holder",
  title: HOLDER_TITLE,
  archived: false,
  generation: 4,
  since: 1_700_000_000_000,
};

function createQueue(responses: readonly QueuedResponse[]) {
  const requests: CapturedRequest[] = [];
  const remaining = [...responses];
  const fetchMock: FetchImplementation = async (input, init) => {
    requests.push({
      bodyText: typeof init?.body === "string" ? init.body : undefined,
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      method: init?.method ?? "GET",
      url: String(input),
    });
    const next = remaining.shift();
    if (!next) {
      throw new Error("No queued SDK test response");
    }
    return new Response(next.rawBody ?? JSON.stringify(next.body), {
      status: next.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetch: fetchMock, requests };
}

function createSdk(fetchImpl: FetchImplementation) {
  return createBbSdk({
    transport: createHttpTransport({
      baseUrl: "http://bb.test",
      fetch: fetchImpl,
      runtime: "node",
    }),
  });
}

describe("@bb/sdk experimental_threadRoles", () => {
  it("reads one role and a snapshot of every role", async () => {
    const unheld = {
      role: "channel",
      threadId: null,
      title: null,
      archived: null,
      generation: 2,
      since: null,
    };
    const queue = createQueue([
      { body: HELD_STATE },
      { body: { roles: [unheld, HELD_STATE] } },
    ]);
    const sdk = createSdk(queue.fetch);

    await expect(
      sdk.experimental_threadRoles.get({ role: "ruler" }),
    ).resolves.toEqual(HELD_STATE);
    await expect(sdk.experimental_threadRoles.list()).resolves.toEqual({
      roles: [unheld, HELD_STATE],
    });
    expect(queue.requests.map((r) => [r.method, r.url])).toEqual([
      ["GET", "http://bb.test/api/v1/thread-roles/ruler"],
      ["GET", "http://bb.test/api/v1/thread-roles"],
    ]);
  });

  it("sends claim, transfer and release bodies", async () => {
    const queue = createQueue([
      { body: HELD_STATE },
      { body: { ...HELD_STATE, generation: 5 } },
      { body: { ...HELD_STATE, threadId: null, title: null, archived: null } },
    ]);
    const sdk = createSdk(queue.fetch);

    await sdk.experimental_threadRoles.claim({
      role: "ruler",
      threadId: "thr_holder",
    });
    await sdk.experimental_threadRoles.transfer({
      role: "ruler",
      toThreadId: "thr_next",
      expectGeneration: 4,
    });
    await sdk.experimental_threadRoles.release({
      role: "ruler",
      expectGeneration: 5,
    });

    expect(queue.requests.map((r) => [r.method, r.url, r.bodyText])).toEqual([
      [
        "POST",
        "http://bb.test/api/v1/thread-roles/ruler/claim",
        JSON.stringify({ threadId: "thr_holder" }),
      ],
      [
        "POST",
        "http://bb.test/api/v1/thread-roles/ruler/transfer",
        JSON.stringify({ toThreadId: "thr_next", expectGeneration: 4 }),
      ],
      [
        "POST",
        "http://bb.test/api/v1/thread-roles/ruler/release",
        JSON.stringify({ expectGeneration: 5 }),
      ],
    ]);
  });

  it("keeps whitespace inside JSON error bodies", async () => {
    const conflict = {
      code: "role_generation_conflict",
      message: "Role ruler moved.",
      details: { current: HELD_STATE },
    };
    const queue = createQueue([
      { rawBody: JSON.stringify(conflict, null, 2), status: 409 },
    ]);
    const sdk = createSdk(queue.fetch);

    await expect(
      sdk.experimental_threadRoles.release({
        role: "ruler",
        expectGeneration: 1,
      }),
    ).rejects.toMatchObject({
      name: "BbHttpError",
      status: 409,
      code: "role_generation_conflict",
      body: conflict,
    });
  });

  it("still collapses whitespace in non-JSON error messages", async () => {
    const queue = createQueue([
      { rawBody: "upstream   said\n\tno", status: 502 },
    ]);
    const sdk = createSdk(queue.fetch);

    await expect(
      sdk.experimental_threadRoles.get({ role: "ruler" }),
    ).rejects.toMatchObject({
      name: "BbHttpError",
      status: 502,
      message: expect.stringContaining("upstream said no"),
    });
  });
});
