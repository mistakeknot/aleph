// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { onDiagnostic } from "@/lib/diagnostics";
import {
  PENDING_INTERACTIONS_REQUEST_TIMEOUT_MS,
  PENDING_INTERACTIONS_UNKNOWN_GRACE_MS,
  PendingInteractionsRequestTimeoutError,
  useGracedPendingInteractionFetching,
  withPendingInteractionsRequestTimeout,
} from "./pending-interactions-guard";

describe("pending-interactions guard", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  describe("withPendingInteractionsRequestTimeout", () => {
    it("rejects and aborts the request signal when it never settles", async () => {
      let requestSignal: AbortSignal | null = null;
      const events: string[] = [];
      const off = onDiagnostic((event) => {
        if (event.kind === "pending-interactions-guard") {
          events.push(`${event.outcome}:${event.threadId}`);
        }
      });
      const result = withPendingInteractionsRequestTimeout({
        request: (signal) => {
          requestSignal = signal;
          return new Promise<string>(() => {});
        },
        signal: new AbortController().signal,
        threadId: "thr_a",
      });
      const assertion = expect(result).rejects.toBeInstanceOf(
        PendingInteractionsRequestTimeoutError,
      );
      await vi.advanceTimersByTimeAsync(
        PENDING_INTERACTIONS_REQUEST_TIMEOUT_MS,
      );
      await assertion;
      off();
      expect((requestSignal as AbortSignal | null)?.aborted).toBe(true);
      expect(events).toEqual(["request-timeout:thr_a"]);
    });

    it("passes through a fast response without emitting a timeout", async () => {
      const events: string[] = [];
      const off = onDiagnostic((event) => events.push(event.kind));
      await expect(
        withPendingInteractionsRequestTimeout({
          request: async () => "ok",
          signal: new AbortController().signal,
          threadId: "thr_a",
        }),
      ).resolves.toBe("ok");
      await vi.advanceTimersByTimeAsync(
        PENDING_INTERACTIONS_REQUEST_TIMEOUT_MS * 2,
      );
      off();
      expect(events).toEqual([]);
    });

    it("forwards a caller abort to the request signal", async () => {
      const parent = new AbortController();
      let requestSignal: AbortSignal | null = null;
      void withPendingInteractionsRequestTimeout({
        request: (signal) => {
          requestSignal = signal;
          return new Promise<string>(() => {});
        },
        signal: parent.signal,
        threadId: "thr_a",
      });
      parent.abort();
      expect((requestSignal as AbortSignal | null)?.aborted).toBe(true);
    });
  });

  describe("useGracedPendingInteractionFetching", () => {
    function render(initial: {
      hasPendingInteraction: boolean;
      isFetching: boolean;
    }) {
      return renderHook(
        (props: { hasPendingInteraction: boolean; isFetching: boolean }) =>
          useGracedPendingInteractionFetching({ ...props, threadId: "thr_a" }),
        { initialProps: initial },
      );
    }

    it("reports fetching until the grace window elapses, then stops blocking", () => {
      const view = render({ hasPendingInteraction: false, isFetching: true });
      expect(view.result.current).toBe(true);
      act(() => {
        vi.advanceTimersByTime(PENDING_INTERACTIONS_UNKNOWN_GRACE_MS - 1);
      });
      expect(view.result.current).toBe(true);
      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(view.result.current).toBe(false);
    });

    it("re-arms the window for the next fetch", () => {
      const view = render({ hasPendingInteraction: false, isFetching: true });
      act(() => {
        vi.advanceTimersByTime(PENDING_INTERACTIONS_UNKNOWN_GRACE_MS);
      });
      view.rerender({ hasPendingInteraction: false, isFetching: false });
      view.rerender({ hasPendingInteraction: false, isFetching: true });
      expect(view.result.current).toBe(true);
    });

    it("never expires while a pending interaction is known", () => {
      const view = render({ hasPendingInteraction: true, isFetching: true });
      act(() => {
        vi.advanceTimersByTime(PENDING_INTERACTIONS_UNKNOWN_GRACE_MS * 5);
      });
      expect(view.result.current).toBe(true);
    });
  });
});
