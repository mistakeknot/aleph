// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BbDesktopApi } from "@bb/desktop-contract";
import { emitDiagnostic } from "@/lib/diagnostics";
import { useAlephDiagnostics } from "./diagnostics-bridge";

const desktopState = vi.hoisted(() => ({
  current: null as Partial<BbDesktopApi> | null,
}));
const wsState = vi.hoisted(() => ({ onChanged: vi.fn(() => () => {}) }));

vi.mock("@/lib/bb-desktop", () => ({
  getBbDesktopInfo: () => desktopState.current,
}));
vi.mock("@/lib/ws", () => ({ wsManager: { onChanged: wsState.onChanged } }));

const payload = {
  kind: "socket-replaced",
  pongPending: false,
  readyState: 1,
} as const;

describe("useAlephDiagnostics", () => {
  beforeEach(() => {
    wsState.onChanged.mockClear();
  });

  afterEach(() => {
    desktopState.current = null;
  });

  it("forwards emitted events when diagnosticsEnabled is true", () => {
    const logDiagnostic = vi.fn();
    desktopState.current = { diagnosticsEnabled: true, logDiagnostic };
    const { unmount } = renderHook(() => useAlephDiagnostics());
    emitDiagnostic(() => payload);
    expect(logDiagnostic).toHaveBeenCalledTimes(1);
    expect(logDiagnostic.mock.calls[0]?.[0]).toMatchObject(payload);
    expect(wsState.onChanged).toHaveBeenCalledTimes(1);
    unmount();
    emitDiagnostic(() => payload);
    expect(logDiagnostic).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["no desktop bridge", null],
    ["a logDiagnostic without the enabled flag", { logDiagnostic: vi.fn() }],
    [
      "the flag set to false",
      { diagnosticsEnabled: false, logDiagnostic: vi.fn() },
    ],
    ["the flag without a sink", { diagnosticsEnabled: true }],
  ])("attaches nothing and computes nothing with %s", (_name, desktop) => {
    desktopState.current = desktop;
    renderHook(() => useAlephDiagnostics());
    const build = vi.fn(() => payload);
    emitDiagnostic(build);
    expect(build).not.toHaveBeenCalled();
    expect(wsState.onChanged).not.toHaveBeenCalled();
  });
});
