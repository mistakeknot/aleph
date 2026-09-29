import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { describeReconnectInvalidation } from "./reconnect-diagnostics";

describe("describeReconnectInvalidation", () => {
  it("records per-query decisions against the disconnect watermark", () => {
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
      queryClient,
      queryKeys: [["thread"], ["thread-pending-interactions"], ["thread"]],
    });
    expect(payload).toMatchObject({
      disconnectedAt: 1000,
      invalidatedCount: 2,
      skippedCount: 1,
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
          invalidated: false,
          queryName: "thread",
          subjectId: "thr_new",
        },
      ]),
    );
    expect(payload.decisions).toHaveLength(3);
    expect(JSON.stringify(payload)).not.toContain("body text");
  });
});
