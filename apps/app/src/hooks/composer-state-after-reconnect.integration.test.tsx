// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PendingInteraction } from "@bb/domain";
import type { ThreadResponse } from "@bb/server-contract";
import { buildFollowUpSubmitMode } from "@bb/client-core";
import { makeThreadResponse } from "@/test/fixtures/thread-responses";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";

const fakeSocketState = vi.hoisted(() => {
  class FakeReconnectingWebSocket {
    onclose: (() => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;
    onopen: (() => void) | null = null;
    readyState = 0;
    readonly sentMessages: string[] = [];

    constructor() {
      instances.push(this);
    }

    close(): void {
      this.readyState = 3;
      this.onclose?.();
    }

    open(): void {
      this.readyState = 1;
      this.onopen?.();
    }

    send(data: string): void {
      this.sentMessages.push(data);
    }
  }

  const instances: FakeReconnectingWebSocket[] = [];
  return { FakeReconnectingWebSocket, instances };
});

vi.mock("partysocket/ws", () => ({
  default: fakeSocketState.FakeReconnectingWebSocket,
}));

vi.mock("@/lib/dev-websocket-url", () => ({
  buildBrowserWebSocketUrl: () => "ws://bb.test/ws",
}));

vi.mock("@/lib/sdk", () => ({
  sdk: {
    threads: {
      get: vi.fn(),
      interactions: { list: vi.fn() },
    },
  },
}));

import { sdk } from "@/lib/sdk";
import { WebSocketManager } from "@/lib/ws";
import { createRealtimeCacheEffects } from "./realtime-cache-effects";
import { threadPendingInteractionsQueryKey, threadQueryKey } from "./queries/query-keys";
import {
  isPendingInteractionStateUnknown,
  useThread,
  useThreadPendingInteractions,
} from "./queries/thread-queries";

const THREAD_ID = "thr_composer";

type RuntimeStatus = "active" | "idle";

function threadWithStatus(status: RuntimeStatus): ThreadResponse {
  return makeThreadResponse({
    id: THREAD_ID,
    status,
    runtime: { displayStatus: status },
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function currentSocket() {
  const socket = fakeSocketState.instances.at(-1);
  if (!socket) {
    throw new Error("Expected a websocket instance");
  }
  return socket;
}

function setup() {
  const wsManager = new WebSocketManager();
  const harness = createQueryClientTestHarness();
  const effects = createRealtimeCacheEffects({
    queryClient: harness.queryClient,
  });
  const unsubscribeConnected = wsManager.onConnected(effects.handleConnected);
  const unsubscribeChanged = wsManager.onChanged(effects.handleChanged);
  wsManager.connect();
  wsManager.subscribe({ kind: "thread-detail", threadId: THREAD_ID });
  currentSocket().open();

  const view = renderHook(
    () => {
      const thread = useThread(THREAD_ID);
      const pendingInteractions = useThreadPendingInteractions(THREAD_ID);
      const runtimeDisplayStatus = thread.data?.runtime.displayStatus;
      if (runtimeDisplayStatus === undefined) {
        return "loading-thread";
      }
      return buildFollowUpSubmitMode({
        hasPendingInteraction: false,
        isDefaultExecutionOptionsLoading: false,
        isPendingInteractionsInitialLoading: isPendingInteractionStateUnknown(
          pendingInteractions.data,
          pendingInteractions.isFetching,
        ),
        isStopRequested: false,
        onStop: () => {},
        runtimeDisplayStatus,
      });
    },
    { wrapper: harness.wrapper },
  );

  return {
    ...harness,
    composerMode: () => {
      const mode = view.result.current;
      return typeof mode === "string" ? mode : mode.kind;
    },
    teardown: () => {
      view.unmount();
      effects.dispose();
      unsubscribeConnected();
      unsubscribeChanged();
      wsManager.disconnect();
    },
  };
}

function dropConnection(): void {
  act(() => {
    currentSocket().close();
  });
}

function restoreConnection(): void {
  act(() => {
    currentSocket().open();
  });
}

describe("composer state after a realtime connection drop", () => {
  const originalWebSocket = globalThis.WebSocket;
  let serverStatus: RuntimeStatus;

  beforeEach(() => {
    fakeSocketState.instances.length = 0;
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      value: { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 },
    });
    vi.mocked(sdk.threads.get).mockImplementation(async () =>
      threadWithStatus(serverStatus),
    );
    vi.mocked(sdk.threads.interactions.list).mockResolvedValue(
      [] as PendingInteraction[],
    );
  });

  afterEach(() => {
    cleanup();
    vi.resetAllMocks();
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      value: originalWebSocket,
    });
  });

  describe.each([
    { before: "active", after: "idle", during: "mid-turn", expected: "ready" },
    { before: "idle", after: "active", during: "while idle", expected: "queue" },
  ] as const)("dropped $during", ({ before, after, expected }) => {
    const settledBefore = before === "active" ? "queue" : "ready";

    it("control: recovers when the state event is missed and the thread was last fetched before the drop", async () => {
      serverStatus = before;
      const ctx = setup();
      await waitFor(() => expect(ctx.composerMode()).toBe(settledBefore));

      dropConnection();
      serverStatus = after;
      await sleep(5);
      restoreConnection();

      await waitFor(() => expect(ctx.composerMode()).toBe(expected));
      ctx.teardown();
    });

    it.fails("recovers when the thread is refetched during the outage, then the state event is missed", async () => {
      serverStatus = before;
      const ctx = setup();
      await waitFor(() => expect(ctx.composerMode()).toBe(settledBefore));

      dropConnection();
      await sleep(5);
      await act(async () => {
        await ctx.queryClient.refetchQueries({
          queryKey: threadQueryKey(THREAD_ID),
        });
      });
      await sleep(5);
      serverStatus = after;
      restoreConnection();

      await waitFor(() => expect(ctx.composerMode()).toBe(expected), {
        timeout: 1500,
      });
      ctx.teardown();
    });

    it.fails("recovers when a fetch already in flight resolves with a pre-event snapshot after reconnect", async () => {
      serverStatus = before;
      const ctx = setup();
      await waitFor(() => expect(ctx.composerMode()).toBe(settledBefore));

      const stale = threadWithStatus(before);
      let resolveStale: (thread: ThreadResponse) => void = () => {};
      vi.mocked(sdk.threads.get).mockImplementationOnce(
        () =>
          new Promise<ThreadResponse>((resolve) => {
            resolveStale = resolve;
          }),
      );
      act(() => {
        void ctx.queryClient.refetchQueries({
          queryKey: threadQueryKey(THREAD_ID),
        });
      });

      dropConnection();
      serverStatus = after;
      await sleep(5);
      restoreConnection();
      await act(async () => {
        resolveStale(stale);
        await sleep(5);
      });

      await waitFor(() => expect(ctx.composerMode()).toBe(expected), {
        timeout: 1500,
      });
      ctx.teardown();
    });
  });

  it.fails("unblocks the composer after reconnect when a pending-interactions fetch never settles", async () => {
    serverStatus = "idle";
    const ctx = setup();
    await waitFor(() => expect(ctx.composerMode()).toBe("ready"));

    vi.mocked(sdk.threads.interactions.list).mockImplementation(
      () => new Promise<PendingInteraction[]>(() => {}),
    );
    act(() => {
      void ctx.queryClient.refetchQueries({
        queryKey: threadPendingInteractionsQueryKey(THREAD_ID),
      });
    });
    await waitFor(() => expect(ctx.composerMode()).toBe("blocked"));

    dropConnection();
    await sleep(5);
    restoreConnection();

    await waitFor(() => expect(ctx.composerMode()).toBe("ready"), {
      timeout: 1500,
    });
    ctx.teardown();
  });
});
