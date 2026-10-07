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

  it("clears the nonce on a definitive refusal that started nothing", async () => {
    api.postAlephUpdate.mockRejectedValue(
      new BbHttpError({
        body: null,
        code: "invalid_request",
        message: "refused",
        status: 400,
      }),
    );
    const { result } = renderHook(() => useAlephUpdateRequest(), { wrapper });
    act(() => result.current.submit("update", BODY));
    await waitFor(() => expect(result.current.failure).not.toBeNull());
    expect(result.current.pending).toBeNull();
    expect(window.localStorage.getItem("aleph-update-pending")).toBeNull();
  });

  it.each([502, 503, 504])(
    "keeps the nonce and keeps polling after an ambiguous HTTP %i",
    async (status) => {
      api.postAlephUpdate.mockRejectedValue(
        new BbHttpError({
          body: null,
          code: null,
          message: "gateway lost response",
          status,
        }),
      );
      api.fetchAlephUpdateRun.mockResolvedValue({
        detail: null,
        nonce: "x",
        state: "running",
      });
      const { result } = renderHook(() => useAlephUpdateRequest(), { wrapper });
      act(() => result.current.submit("update", BODY));
      await waitFor(() => expect(result.current.runState).toBe("running"));
      expect(result.current.pending).not.toBeNull();
      expect(
        window.localStorage.getItem("aleph-update-pending"),
      ).not.toBeNull();
      expect(api.postAlephUpdate).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["aleph_update_command_only", "aleph_update_start_denied"])(
    "keeps tracking the manual command nonce on %s, without resending, and resumes after reload",
    async (code) => {
      vi.useFakeTimers({
        toFake: [
          "Date",
          "setInterval",
          "clearInterval",
          "setTimeout",
          "clearTimeout",
        ],
      });
      api.postAlephUpdate.mockRejectedValue(
        new BbHttpError({
          body: { details: { command: "systemctl start --no-block unit" } },
          code,
          message: "start it from a root shell",
          status: 409,
        }),
      );
      api.fetchAlephUpdateRun.mockResolvedValue({
        detail: null,
        nonce: "x",
        state: "not-found",
      });
      const first = renderHook(() => useAlephUpdateRequest(), { wrapper });
      act(() => first.result.current.submit("update", BODY));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      const nonce = first.result.current.pending?.nonce;
      expect(first.result.current.failure?.command).toBe(
        "systemctl start --no-block unit",
      );
      expect(nonce).toMatch(/^[0-9a-f]{32}$/u);
      expect(api.fetchAlephUpdateRun).toHaveBeenCalled();

      await act(async () => {
        vi.setSystemTime(Date.now() + 61_000);
        await vi.advanceTimersByTimeAsync(2_100);
      });
      expect(api.postAlephUpdate).toHaveBeenCalledTimes(1);
      first.unmount();

      api.fetchAlephUpdateRun.mockResolvedValue({
        detail: null,
        nonce: "x",
        state: "running",
      });
      const second = renderHook(() => useAlephUpdateRequest(), { wrapper });
      expect(second.result.current.pending?.nonce).toBe(nonce);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_100);
      });
      expect(second.result.current.runState).toBe("running");
      expect(api.postAlephUpdate).toHaveBeenCalledTimes(1);
    },
  );

  it("shows outcome unknown after 55 minutes with every run lookup unreachable", async () => {
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
    api.fetchAlephUpdateRun.mockRejectedValue(
      new TypeError("server unreachable"),
    );
    const { result } = renderHook(() => useAlephUpdateRequest(), { wrapper });
    act(() => result.current.submit("update", BODY));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const nonce = result.current.pending?.nonce;
    expect(result.current.unknownMessage).toBeNull();
    await act(async () => {
      vi.setSystemTime(Date.now() + 56 * 60_000);
      await vi.advanceTimersByTimeAsync(2_100);
    });
    expect(result.current.pending?.nonce).toBe(nonce);
    expect(result.current.unknownMessage).toBe(
      `Outcome unknown: run \`aleph-update status ${nonce}\` (root shell)`,
    );
  });

  it("still warns at 55 minutes of elapsed time after the wall clock moves back a day", async () => {
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
    api.fetchAlephUpdateRun.mockRejectedValue(
      new TypeError("server unreachable"),
    );
    const { result } = renderHook(() => useAlephUpdateRequest(), { wrapper });
    act(() => result.current.submit("update", BODY));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const nonce = result.current.pending?.nonce;
    await act(async () => {
      vi.setSystemTime(Date.now() - 24 * 60 * 60_000);
      await vi.advanceTimersByTimeAsync(56 * 60_000);
    });
    expect(result.current.pending?.nonce).toBe(nonce);
    expect(result.current.unknownMessage).toBe(
      `Outcome unknown: run \`aleph-update status ${nonce}\` (root shell)`,
    );
  });

  it("keeps elapsed progress across a reload that follows a backward clock change", async () => {
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
    api.fetchAlephUpdateRun.mockRejectedValue(
      new TypeError("server unreachable"),
    );
    const first = renderHook(() => useAlephUpdateRequest(), { wrapper });
    act(() => first.result.current.submit("update", BODY));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const nonce = first.result.current.pending?.nonce;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(54 * 60_000);
    });
    expect(first.result.current.unknownMessage).toBeNull();
    first.unmount();
    vi.setSystemTime(Date.now() - 24 * 60 * 60_000);
    const second = renderHook(() => useAlephUpdateRequest(), { wrapper });
    expect(second.result.current.pending?.nonce).toBe(nonce);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2 * 60_000);
    });
    expect(second.result.current.unknownMessage).toContain("Outcome unknown");
  });

  it("shows outcome unknown at once when the wall clock went backward across an offline reload", async () => {
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
    api.fetchAlephUpdateRun.mockRejectedValue(
      new TypeError("server unreachable"),
    );
    const first = renderHook(() => useAlephUpdateRequest(), { wrapper });
    act(() => first.result.current.submit("update", BODY));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const nonce = first.result.current.pending?.nonce;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20 * 60_000);
    });
    expect(first.result.current.unknownMessage).toBeNull();
    first.unmount();
    vi.setSystemTime(Date.now() + 2 * 60 * 60_000);
    vi.setSystemTime(Date.now() - 26 * 60 * 60_000);
    const second = renderHook(() => useAlephUpdateRequest(), { wrapper });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(second.result.current.pending?.nonce).toBe(nonce);
    expect(second.result.current.unknownMessage).toContain("Outcome unknown");
  });

  it("shows outcome unknown for a stored request past 55 minutes after reload while the server is unreachable", async () => {
    window.localStorage.setItem(
      "aleph-update-pending",
      JSON.stringify({
        nonce: "9".repeat(32),
        operation: "update",
        body: BODY,
        sentAt: Date.now() - 56 * 60_000,
        resent: true,
      }),
    );
    api.fetchAlephUpdateRun.mockRejectedValue(
      new TypeError("server unreachable"),
    );
    const { result } = renderHook(() => useAlephUpdateRequest(), { wrapper });
    await waitFor(() =>
      expect(result.current.unknownMessage).toContain("Outcome unknown"),
    );
    expect(result.current.pending?.nonce).toBe("9".repeat(32));
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

  describe("dismissing an outcome-unknown warning", () => {
    const NONCE = "9".repeat(32);

    function storeStale() {
      window.localStorage.setItem(
        "aleph-update-pending",
        JSON.stringify({
          nonce: NONCE,
          operation: "update",
          body: BODY,
          sentAt: Date.now() - 56 * 60_000,
          resent: true,
        }),
      );
      api.fetchAlephUpdateRun.mockResolvedValue({
        detail: null,
        nonce: NONCE,
        state: "running",
      });
    }

    it("hides the warning but keeps tracking the original nonce", async () => {
      storeStale();
      const { result } = renderHook(() => useAlephUpdateRequest(), { wrapper });
      await waitFor(() =>
        expect(result.current.unknownMessage).toContain("Outcome unknown"),
      );
      act(() => result.current.dismiss());
      expect(result.current.unknownMessage).toBeNull();
      expect(result.current.pending?.nonce).toBe(NONCE);
      expect(
        JSON.parse(window.localStorage.getItem("aleph-update-pending") ?? "null")
          .nonce,
      ).toBe(NONCE);
      await waitFor(() => expect(result.current.runState).toBe("running"));
      expect(result.current.unknownMessage).toBeNull();
    });

    it("refuses a new press until the original nonce resolves", async () => {
      storeStale();
      const { result } = renderHook(() => useAlephUpdateRequest(), { wrapper });
      await waitFor(() =>
        expect(result.current.unknownMessage).toContain("Outcome unknown"),
      );
      act(() => result.current.dismiss());
      act(() => result.current.submit("update", BODY));
      expect(api.postAlephUpdate).not.toHaveBeenCalled();
      expect(result.current.pending?.nonce).toBe(NONCE);
    });

    it("still tracks the original nonce after a reload", async () => {
      storeStale();
      const first = renderHook(() => useAlephUpdateRequest(), { wrapper });
      await waitFor(() =>
        expect(first.result.current.unknownMessage).toContain("Outcome unknown"),
      );
      act(() => first.result.current.dismiss());
      first.unmount();
      const second = renderHook(() => useAlephUpdateRequest(), { wrapper });
      expect(second.result.current.pending?.nonce).toBe(NONCE);
      act(() => second.result.current.submit("update", BODY));
      expect(api.postAlephUpdate).not.toHaveBeenCalled();
    });

    it("accepts a new press once the original nonce reaches an outcome", async () => {
      storeStale();
      const { result } = renderHook(() => useAlephUpdateRequest(), { wrapper });
      await waitFor(() =>
        expect(result.current.unknownMessage).toContain("Outcome unknown"),
      );
      act(() => result.current.dismiss());
      api.fetchAlephUpdateRun.mockResolvedValue({
        detail: null,
        nonce: NONCE,
        state: "succeeded",
      });
      await waitFor(() => expect(result.current.pending).toBeNull(), {
        timeout: 5_000,
      });
      api.postAlephUpdate.mockResolvedValue({
        detail: null,
        nonce: "x",
        state: "queued",
      });
      act(() => result.current.submit("update", BODY));
      await waitFor(() => expect(api.postAlephUpdate).toHaveBeenCalledTimes(1));
      expect(api.postAlephUpdate.mock.calls[0]?.[1]).not.toHaveProperty(
        "nonce",
        NONCE,
      );
    });
  });
});
