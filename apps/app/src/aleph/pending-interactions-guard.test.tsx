// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import {
  onlineManager,
  QueryClient,
  QueryClientProvider,
  useQuery,
} from "@tanstack/react-query";
import type { ReactNode } from "react";
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
      status: "error" | "pending" | "success";
      fetchStatus: "fetching" | "idle" | "paused";
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
      status: "success",
      fetchStatus: "idle",
      threadId: "thr_a",
    };

    it("is verified only after a settled successful result", () => {
      const view = render({
        ...base,
        status: "pending",
        fetchStatus: "fetching",
      });
      expect(view.result.current).toEqual({ isUnverified: true, retry: null });
      view.rerender(base);
      expect(view.result.current).toEqual({ isUnverified: false, retry: null });
    });

    it("does not treat an error as known and offers a retry", () => {
      const view = render({ ...base, status: "error" });
      expect(view.result.current.isUnverified).toBe(true);
      expect(view.result.current.retry).not.toBeNull();
      view.rerender({ ...base, status: "error", fetchStatus: "fetching" });
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
      const view = render({ ...base, status: "error" });
      act(() => view.result.current.retry?.());
      off();
      expect(refetch).toHaveBeenCalledTimes(1);
      expect(events).toEqual(["check-failed", "manual-retry"]);
    });

    it("stays blocked with no data and no fetch in flight (paused or disabled)", () => {
      const view = render({ ...base, status: "pending" });
      expect(view.result.current).toEqual({ isUnverified: true, retry: null });
    });

    it("blocks a cached success whose refresh is paused", () => {
      const view = render({ ...base, fetchStatus: "paused" });
      expect(view.result.current).toEqual({ isUnverified: true, retry: null });
      view.rerender({ ...base, fetchStatus: "idle" });
      expect(view.result.current.isUnverified).toBe(false);
    });

    it("stays verified while a pending interaction is known", () => {
      const view = render({
        ...base,
        hasPendingInteraction: true,
        fetchStatus: "fetching",
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
      const view = render({
        ...base,
        status: "pending",
        fetchStatus: "fetching",
      });
      view.rerender({ ...base, status: "error" });
      view.rerender({ ...base, status: "error", fetchStatus: "fetching" });
      view.rerender(base);
      off();
      expect(events).toEqual([
        "blocked-unverified",
        "check-failed",
        "resolved",
      ]);
    });

    it("keeps no state across a thread switch", () => {
      const view = render({ ...base, status: "error" });
      view.rerender({ ...base, threadId: "thr_b" });
      expect(view.result.current).toEqual({ isUnverified: false, retry: null });
    });
  });

  describe("usePendingInteractionsGate with a real query", () => {
    const wrapperFor = (client: QueryClient) =>
      function Wrapper({ children }: { children: ReactNode }) {
        return (
          <QueryClientProvider client={client}>{children}</QueryClientProvider>
        );
      };

    function renderGate(
      client: QueryClient,
      initial: {
        enabled: boolean;
        queryFn: () => Promise<unknown[]>;
        threadId: string;
      },
    ) {
      return renderHook(
        (props: typeof initial) => {
          const query = useQuery({
            enabled: props.enabled,
            queryFn: props.queryFn,
            queryKey: ["pending-interactions-test", props.threadId],
          });
          return usePendingInteractionsGate({
            hasPendingInteraction: (query.data?.length ?? 0) > 0,
            query,
            threadId: props.threadId,
          });
        },
        { initialProps: initial, wrapper: wrapperFor(client) },
      );
    }

    async function flush() {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
    }

    function makeClient() {
      return new QueryClient({ defaultOptions: { queries: { retry: false } } });
    }

    it("blocks a disabled query with no data, then verifies once enabled and fetched", async () => {
      const client = makeClient();
      const queryFn = vi.fn(async () => []);
      const view = renderGate(client, {
        enabled: false,
        queryFn,
        threadId: "thr_a",
      });
      await flush();
      expect(queryFn).not.toHaveBeenCalled();
      expect(view.result.current).toEqual({ isUnverified: true, retry: null });
      view.rerender({ enabled: true, queryFn, threadId: "thr_a" });
      await flush();
      expect(view.result.current).toEqual({ isUnverified: false, retry: null });
    });

    it("blocks a paused initial fetch and resolves when the network resumes", async () => {
      const client = makeClient();
      onlineManager.setOnline(false);
      try {
        const queryFn = vi.fn(async () => []);
        const view = renderGate(client, {
          enabled: true,
          queryFn,
          threadId: "thr_a",
        });
        await flush();
        expect(queryFn).not.toHaveBeenCalled();
        expect(view.result.current.isUnverified).toBe(true);
        onlineManager.setOnline(true);
        await flush();
        expect(view.result.current).toEqual({
          isUnverified: false,
          retry: null,
        });
      } finally {
        onlineManager.setOnline(true);
      }
    });

    it("blocks a cached success whose refresh is paused offline", async () => {
      const client = makeClient();
      const view = renderGate(client, {
        enabled: true,
        queryFn: async () => [],
        threadId: "thr_a",
      });
      await flush();
      expect(view.result.current.isUnverified).toBe(false);
      onlineManager.setOnline(false);
      try {
        await act(async () => {
          void client.refetchQueries({
            queryKey: ["pending-interactions-test", "thr_a"],
          });
          await vi.advanceTimersByTimeAsync(0);
        });
        expect(view.result.current.isUnverified).toBe(true);
      } finally {
        onlineManager.setOnline(true);
      }
      await flush();
      expect(view.result.current.isUnverified).toBe(false);
    });

    it("blocks a pending first fetch until it succeeds", async () => {
      const client = makeClient();
      let resolve: (value: unknown[]) => void = () => {};
      const view = renderGate(client, {
        enabled: true,
        queryFn: () =>
          new Promise<unknown[]>((r) => {
            resolve = r;
          }),
        threadId: "thr_a",
      });
      await flush();
      expect(view.result.current.isUnverified).toBe(true);
      await act(async () => {
        resolve([]);
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(view.result.current.isUnverified).toBe(false);
    });

    it("blocks again on a thread switch until the new thread's query succeeds", async () => {
      const client = makeClient();
      const view = renderGate(client, {
        enabled: true,
        queryFn: async () => [],
        threadId: "thr_a",
      });
      await flush();
      expect(view.result.current.isUnverified).toBe(false);
      view.rerender({
        enabled: true,
        queryFn: () => new Promise<unknown[]>(() => {}),
        threadId: "thr_b",
      });
      await flush();
      expect(view.result.current.isUnverified).toBe(true);
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
