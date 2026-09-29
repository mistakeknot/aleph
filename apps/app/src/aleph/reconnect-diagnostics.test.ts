import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { describeReconnectInvalidation } from "./reconnect-diagnostics";

describe("describeReconnectInvalidation", () => {
  it("records per-query decisions against the reconnect-open time", () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(
      ["thread", "thr_old"],
      { secret: "body text" },
      { updatedAt: 500 },
    );
    queryClient.setQueryData(
      ["thread", "thr_new"],
      { secret: "body text" },
      { updatedAt: 1500 },
    );
    queryClient.setQueryData(["thread-pending-interactions", "thr_old"], [], {
      updatedAt: 900,
    });
    const payload = describeReconnectInvalidation({
      disconnectedAt: 1000,
      reconnectedAt: 2000,
      queryClient,
      queryKeys: [["thread"], ["thread-pending-interactions"], ["thread"]],
    });
    expect(payload).toMatchObject({
      disconnectedAt: 1000,
      reconnectedAt: 2000,
      invalidatedCount: 3,
      skippedCount: 0,
    });
    expect(payload.decisions).toEqual(
      expect.arrayContaining([
        {
          dataUpdatedAt: 500,
          fetching: false,
          invalidated: true,
          queryName: "thread",
          subjectId: "thr_old",
        },
        {
          dataUpdatedAt: 1500,
          fetching: false,
          invalidated: true,
          queryName: "thread",
          subjectId: "thr_new",
        },
      ]),
    );
    expect(payload.decisions).toHaveLength(3);
    expect(JSON.stringify(payload)).not.toContain("body text");
  });
});

describe("describeReconnectInvalidation reconnect-open watermark", () => {
  it("skips only queries fetched at or after the reconnect-open time", () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(["thread", "thr_outage"], {}, { updatedAt: 1500 });
    queryClient.setQueryData(["thread", "thr_open"], {}, { updatedAt: 2000 });
    const payload = describeReconnectInvalidation({
      disconnectedAt: 1000,
      queryClient,
      queryKeys: [["thread"]],
      reconnectedAt: 2000,
    });
    expect(payload.invalidatedCount).toBe(1);
    expect(payload.skippedCount).toBe(1);
  });
});
