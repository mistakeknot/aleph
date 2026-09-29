// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { onDiagnostic } from "@/lib/diagnostics";
import {
  PENDING_INTERACTIONS_REQUEST_TIMEOUT_MS,
  PENDING_INTERACTIONS_AUTO_RETRY_INTERVAL_MS,
  PendingInteractionsRequestTimeoutError,
  pendingInteractionsRefetchInterval,
  usePendingInteractionsGate,
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

  describe("usePendingInteractionsGate", () => {
    interface Props {
      hasPendingInteraction: boolean;
      isError: boolean;
      isFetching: boolean;
      threadId: string;
    }
    const refetch = vi.fn(async () => undefined);

    function render(initial: Props) {
      return renderHook(
        ({ threadId, hasPendingInteraction, ...query }: Props) =>
          usePendingInteractionsGate({
            hasPendingInteraction,
            query: { ...query, refetch },
            threadId,
          }),
        { initialProps: initial },
      );
    }
    const base: Props = {
      hasPendingInteraction: false,
      isError: false,
      isFetching: false,
      threadId: "thr_a",
    };

    it("is verified only after a settled successful result", () => {
      const view = render({ ...base, isFetching: true });
      expect(view.result.current).toEqual({ isUnverified: true, retry: null });
      view.rerender(base);
      expect(view.result.current).toEqual({ isUnverified: false, retry: null });
    });

    it("does not treat an error as known and offers a retry", () => {
      const view = render({ ...base, isError: true });
      expect(view.result.current.isUnverified).toBe(true);
      expect(view.result.current.retry).not.toBeNull();
      view.rerender({ ...base, isError: true, isFetching: true });
      expect(view.result.current.isUnverified).toBe(true);
      expect(view.result.current.retry).not.toBeNull();
    });

    it("invokes the query refetch on retry and records the manual retry", () => {
      const events: string[] = [];
      const off = onDiagnostic((event) => {
        if (event.kind === "pending-interactions-guard") {
          events.push(event.outcome);
        }
      });
      const view = render({ ...base, isError: true });
      act(() => view.result.current.retry?.());
      off();
      expect(refetch).toHaveBeenCalledTimes(1);
      expect(events).toEqual(["check-failed", "manual-retry"]);
    });

    it("stays verified while a pending interaction is known", () => {
      const view = render({
        ...base,
        hasPendingInteraction: true,
        isFetching: true,
      });
      expect(view.result.current).toEqual({ isUnverified: false, retry: null });
    });

    it("emits blocked-unverified, check-failed and resolved on transitions", () => {
      const events: string[] = [];
      const off = onDiagnostic((event) => {
        if (event.kind === "pending-interactions-guard") {
          events.push(event.outcome);
        }
      });
      const view = render({ ...base, isFetching: true });
      view.rerender({ ...base, isError: true });
      view.rerender({ ...base, isError: true, isFetching: true });
      view.rerender(base);
      off();
      expect(events).toEqual([
        "blocked-unverified",
        "check-failed",
        "resolved",
      ]);
    });

    it("keeps no state across a thread switch", () => {
      const view = render({ ...base, isError: true });
      view.rerender({ ...base, threadId: "thr_b" });
      expect(view.result.current).toEqual({ isUnverified: false, retry: null });
    });
  });

  describe("pendingInteractionsRefetchInterval", () => {
    it("polls only while the query is in the error state", () => {
      expect(
        pendingInteractionsRefetchInterval({ state: { status: "error" } }),
      ).toBe(PENDING_INTERACTIONS_AUTO_RETRY_INTERVAL_MS);
      expect(
        pendingInteractionsRefetchInterval({ state: { status: "success" } }),
      ).toBe(false);
    });
  });
});
