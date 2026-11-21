import { describe, expect, it, vi } from "vitest";
import { createBbSdk } from "../src/core.js";
import { createHttpTransport } from "../src/transport-http.js";
import type { FetchImplementation } from "../src/response.js";

function fixture() {
  const fetch = vi.fn<FetchImplementation>(async () =>
    Response.json({ ok: true }),
  );
  const sdk = createBbSdk({
    transport: createHttpTransport({
      baseUrl: "https://example.test",
      fetch,
      runtime: "node",
    }),
  });
  return { fetch, sdk };
}
const base = {
  projectId: "project",
  prompt: "hello",
  environment: {
    type: "host" as const,
    hostId: "host",
    workspace: { type: "unmanaged" as const, path: null },
  },
};
describe("prompt cache TTL", () => {
  it("serializes the option on spawn, start and fork", async () => {
    const { sdk, fetch } = fixture();
    const execution = { promptCacheTtl: "1h" as const };
    await sdk.threads.spawn({ ...base, execution });
    await sdk.threads.send({
      threadId: "thread",
      mode: "start",
      input: [{ type: "text", text: "hello", mentions: [] }],
      execution,
    });
    await sdk.threads.fork({ sourceThreadId: "thread", execution });
    expect(fetch).toHaveBeenCalledTimes(3);
    for (const [, init] of fetch.mock.calls)
      expect(JSON.parse(String(init?.body))).toMatchObject({ execution });
  });
  it("rejects invalid options before transport", async () => {
    const { sdk, fetch } = fixture();
    const execution = JSON.parse('{"promptCacheTtl":"2h"}');
    await expect(sdk.threads.spawn({ ...base, execution })).rejects.toThrow(
      /5m|1h/,
    );
    await expect(
      sdk.threads.send({
        threadId: "thread",
        mode: "start",
        input: [{ type: "text", text: "hello", mentions: [] }],
        execution,
      }),
    ).rejects.toThrow(/5m|1h/);
    await expect(
      sdk.threads.fork({ sourceThreadId: "thread", execution }),
    ).rejects.toThrow(/5m|1h/);
    expect(fetch).not.toHaveBeenCalled();
  });
});
