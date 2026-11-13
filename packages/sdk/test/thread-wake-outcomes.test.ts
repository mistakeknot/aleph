import { describe, expect, it, vi } from "vitest";
import { createBbSdk } from "../src/core.js";
import type { FetchImplementation } from "../src/response.js";
import { createHttpTransport } from "../src/transport-http.js";

describe("wake outcome report transport", () => {
  it("uses the shared HTTP report and preserves unknowns and explicit zeroes", async () => {
    const report = {
      outcomes: [],
      truncated: false,
      summary: {
        completedTurns: 0,
        unknownCauseRate: null,
        unknownEffectRate: null,
      },
    };
    const fetch = vi.fn<FetchImplementation>(async () => Response.json(report));
    const sdk = createBbSdk({
      transport: createHttpTransport({
        baseUrl: "https://example.test",
        fetch,
        runtime: "node",
      }),
    });
    expect(
      await sdk.threads.experimental_wakeOutcomes({ threadId: "thread-1" }),
    ).toEqual(report);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe(
      "https://example.test/api/v1/threads/thread-1/wake-outcomes",
    );
    expect(init?.method ?? "GET").toBe("GET");
    expect(init?.body).toBeUndefined();
  });

  it("rejects malformed reports rather than treating absent coverage as zero", async () => {
    const fetch = vi.fn<FetchImplementation>(async () =>
      Response.json({ outcomes: [{ turnId: "turn-1" }] }),
    );
    const sdk = createBbSdk({
      transport: createHttpTransport({
        baseUrl: "https://example.test",
        fetch,
        runtime: "node",
      }),
    });
    await expect(
      sdk.threads.experimental_wakeOutcomes({ threadId: "thread-1" }),
    ).rejects.toThrow("Server returned an invalid wake outcome report");
  });
});
