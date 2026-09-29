import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BbDesktopDiagnosticEvent } from "@bb/desktop-contract";

const fakeSocketState = vi.hoisted(() => {
  class FakeReconnectingWebSocket {
    onclose: ((event?: CloseEvent) => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;
    onopen: (() => void) | null = null;
    readyState = 0;

    constructor() {
      instances.push(this);
    }

    close(): void {
      this.readyState = 3;
    }

    send(): void {}
  }

  const instances: FakeReconnectingWebSocket[] = [];
  return { FakeReconnectingWebSocket, instances };
});

vi.mock("partysocket/ws", () => ({
  default: fakeSocketState.FakeReconnectingWebSocket,
}));

vi.mock("./dev-websocket-url", () => ({
  buildBrowserWebSocketUrl: () => "ws://bb.test/ws",
}));

import { onDiagnostic } from "./diagnostics";
import { WebSocketManager } from "./ws";

describe("WebSocketManager diagnostics", () => {
  const events: BbDesktopDiagnosticEvent[] = [];
  let unsubscribe = () => {};

  beforeEach(() => {
    fakeSocketState.instances.length = 0;
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      value: { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 },
    });
    unsubscribe = onDiagnostic((event) => events.push(event));
  });

  afterEach(() => {
    unsubscribe();
    events.length = 0;
  });

  it("emits open, close with code and a token reason, and reconnect open with the outage start", () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const manager = new WebSocketManager({
      isDocumentVisible: () => true,
      subscribeToOnline: () => () => {},
      subscribeToVisibility: () => () => {},
    });
    manager.connect();
    manager.subscribe({ kind: "thread-detail", threadId: "thr_1" });
    const socket = fakeSocketState.instances[0]!;
    socket.readyState = 1;
    socket.onopen?.();
    vi.setSystemTime(20_000);
    socket.onclose?.({
      code: 1006,
      reason: "tunnel lost: secret text here",
      wasClean: false,
    } as CloseEvent);
    vi.setSystemTime(25_000);
    socket.onopen?.();
    manager.disconnect();
    vi.useRealTimers();

    expect(events.map((event) => event.kind)).toEqual([
      "socket-open",
      "socket-close",
      "socket-open",
    ]);
    expect(events[0]).toMatchObject({
      at: 10_000,
      disconnectedAt: null,
      reconnected: false,
      subscriptionCount: 1,
    });
    expect(events[1]).toMatchObject({
      at: 20_000,
      code: 1006,
      pongPending: false,
      reason: "tunnel_lost:_secret_text_here",
      wasClean: false,
    });
    expect(events[2]).toMatchObject({
      at: 25_000,
      disconnectedAt: 20_000,
      reconnected: true,
    });
  });

  it("emits nothing when no listener is registered", () => {
    unsubscribe();
    const manager = new WebSocketManager({
      isDocumentVisible: () => true,
      subscribeToOnline: () => () => {},
      subscribeToVisibility: () => () => {},
    });
    manager.connect();
    fakeSocketState.instances[0]!.onopen?.();
    manager.disconnect();
    expect(events).toEqual([]);
    unsubscribe = onDiagnostic((event) => events.push(event));
  });
});
