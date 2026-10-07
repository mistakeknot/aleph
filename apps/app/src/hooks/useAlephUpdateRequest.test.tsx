// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BbHttpError } from "@bb/sdk/browser";
import { useAlephUpdateRequest } from "./useAlephUpdateRequest";

const api = vi.hoisted(() => ({
  fetchAlephUpdateRun: vi.fn(),
  postAlephUpdate: vi.fn(),
}));

vi.mock("@/lib/aleph-update-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/aleph-update-api")>()),
  ...api,
}));

const BODY = {
  confirm: "update",
  interrupt: false,
  manifestDigest: "f".repeat(64),
  target: "0.5.4",
};

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  window.localStorage.clear();
  api.fetchAlephUpdateRun.mockReset();
  api.postAlephUpdate.mockReset();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useAlephUpdateRequest", () => {
  it("persists the request before posting and posts the stored body", async () => {
    let storedAtPost: string | null = null;
    api.postAlephUpdate.mockImplementation(async () => {
      storedAtPost = window.localStorage.getItem("aleph-update-pending");
      return { detail: null, nonce: "x", state: "queued" };
    });
    api.fetchAlephUpdateRun.mockResolvedValue({
      detail: null,
      nonce: "x",
      state: "running",
    });
    const { result } = renderHook(() => useAlephUpdateRequest(), { wrapper });
    act(() => result.current.submit("update", BODY));
    await waitFor(() => expect(api.postAlephUpdate).toHaveBeenCalled());
    const stored = JSON.parse(storedAtPost ?? "null");
    expect(stored.body).toEqual(BODY);
    const [operation, posted] = api.postAlephUpdate.mock.calls[0] ?? [];
    expect(operation).toBe("update");
    expect(posted).toEqual({ ...BODY, nonce: stored.nonce });
  });

  it("clears the stored nonce once the run reaches an outcome", async () => {
    api.postAlephUpdate.mockResolvedValue({
      detail: null,
      nonce: "x",
      state: "queued",
    });
    api.fetchAlephUpdateRun.mockResolvedValue({
      detail: null,
      nonce: "x",
      state: "succeeded",
    });
    const { result } = renderHook(() => useAlephUpdateRequest(), { wrapper });
    act(() => result.current.submit("update", BODY));
    await waitFor(() =>
      expect(result.current.finished?.state).toBe("succeeded"),
    );
    expect(result.current.pending).toBeNull();
    expect(window.localStorage.getItem("aleph-update-pending")).toBeNull();
  });

  it("clears the nonce and surfaces the command on a definitive refusal", async () => {
    api.postAlephUpdate.mockRejectedValue(
      new BbHttpError({
        body: { details: { command: "systemctl start --no-block unit" } },
        code: "aleph_update_command_only",
        message: "start it from a root shell",
        status: 409,
      }),
    );
    api.fetchAlephUpdateRun.mockResolvedValue({
      detail: null,
      nonce: "x",
      state: "not-found",
    });
    const { result } = renderHook(() => useAlephUpdateRequest(), { wrapper });
    act(() => result.current.submit("update", BODY));
    await waitFor(() => expect(result.current.failure).not.toBeNull());
    expect(result.current.failure?.command).toBe(
      "systemctl start --no-block unit",
    );
    expect(result.current.pending).toBeNull();
    expect(window.localStorage.getItem("aleph-update-pending")).toBeNull();
  });

  it("keeps the nonce on a network failure, resends the identical body once after 60 seconds, then reports unknown at 55 minutes", async () => {
    vi.useFakeTimers({
      toFake: [
        "Date",
        "setInterval",
        "clearInterval",
        "setTimeout",
        "clearTimeout",
      ],
    });
    api.postAlephUpdate.mockRejectedValue(new TypeError("network down"));
    api.fetchAlephUpdateRun.mockResolvedValue({
      detail: null,
      nonce: "x",
      state: "not-found",
    });
    const { result } = renderHook(() => useAlephUpdateRequest(), { wrapper });
    act(() => result.current.submit("update", BODY));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const nonce = result.current.pending?.nonce;
    expect(nonce).toMatch(/^[0-9a-f]{32}$/u);
    expect(api.postAlephUpdate).toHaveBeenCalledTimes(1);

    async function elapse(ms: number) {
      await act(async () => {
        vi.setSystemTime(Date.now() + ms);
        await vi.advanceTimersByTimeAsync(2_100);
      });
    }

    await elapse(61_000);
    expect(api.postAlephUpdate).toHaveBeenCalledTimes(2);
    expect(api.postAlephUpdate.mock.calls[1]?.[1]).toEqual({ ...BODY, nonce });

    await elapse(10 * 60_000);
    expect(api.postAlephUpdate).toHaveBeenCalledTimes(2);
    expect(result.current.unknownMessage).toBeNull();

    await elapse(50 * 60_000);
    expect(result.current.unknownMessage).toBe(
      `Outcome unknown: run \`aleph-update status ${nonce}\` (root shell)`,
    );
    expect(result.current.finished).toBeNull();
    expect(result.current.pending?.nonce).toBe(nonce);
  });

  it("resumes a stored request after a reload", async () => {
    window.localStorage.setItem(
      "aleph-update-pending",
      JSON.stringify({
        nonce: "9".repeat(32),
        operation: "update",
        body: BODY,
        sentAt: Date.now(),
        resent: false,
      }),
    );
    api.fetchAlephUpdateRun.mockResolvedValue({
      detail: null,
      nonce: "9".repeat(32),
      state: "running",
    });
    const { result } = renderHook(() => useAlephUpdateRequest(), { wrapper });
    expect(result.current.pending?.nonce).toBe("9".repeat(32));
    await waitFor(() => expect(result.current.runState).toBe("running"));
    expect(api.postAlephUpdate).not.toHaveBeenCalled();
  });
});
