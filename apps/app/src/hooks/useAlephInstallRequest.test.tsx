// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAlephInstallRequest } from "./useAlephInstallRequest";

const api = vi.hoisted(() => ({
  postAlephInstallCancel: vi.fn(),
  postAlephInstallRequest: vi.fn(),
}));

vi.mock("@/lib/aleph-update-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/aleph-update-api")>()),
  ...api,
}));

const TARGET = {
  aleph: "0.5.4",
  manifestDigest: "f".repeat(64),
  version: "0.44.0+aleph.0.5.4",
};

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  api.postAlephInstallCancel.mockReset();
  api.postAlephInstallRequest.mockReset();
});

afterEach(cleanup);

describe("useAlephInstallRequest", () => {
  it("posts the target version and digest with a fresh nonce", async () => {
    api.postAlephInstallRequest.mockResolvedValue({});
    const { result } = renderHook(() => useAlephInstallRequest(), { wrapper });
    act(() => result.current.request(TARGET));
    await waitFor(() =>
      expect(api.postAlephInstallRequest).toHaveBeenCalledTimes(1),
    );
    const body = api.postAlephInstallRequest.mock.calls[0]?.[0];
    expect(body).toMatchObject({
      manifestDigest: TARGET.manifestDigest,
      target: TARGET.version,
    });
    expect(body.nonce).toMatch(/^[0-9a-f]{32}$/u);
    await waitFor(() => expect(result.current.pending).toBe(false));
  });

  it("uses a distinct nonce for each request", async () => {
    api.postAlephInstallRequest.mockResolvedValue({});
    const { result } = renderHook(() => useAlephInstallRequest(), { wrapper });
    act(() => result.current.request(TARGET));
    await waitFor(() =>
      expect(api.postAlephInstallRequest).toHaveBeenCalledTimes(1),
    );
    await waitFor(() => expect(result.current.pending).toBe(false));
    act(() => result.current.request(TARGET));
    await waitFor(() =>
      expect(api.postAlephInstallRequest).toHaveBeenCalledTimes(2),
    );
    const [first, second] = api.postAlephInstallRequest.mock.calls;
    expect(first?.[0].nonce).not.toBe(second?.[0].nonce);
  });

  it("surfaces a failure and clears it on the next attempt", async () => {
    api.postAlephInstallRequest.mockRejectedValueOnce(new Error("nope"));
    api.postAlephInstallRequest.mockResolvedValueOnce({});
    const { result } = renderHook(() => useAlephInstallRequest(), { wrapper });
    act(() => result.current.request(TARGET));
    await waitFor(() => expect(result.current.error).toBe("nope"));
    act(() => result.current.request(TARGET));
    await waitFor(() => expect(result.current.error).toBeNull());
  });

  it("posts a cancel for the given nonce", async () => {
    api.postAlephInstallCancel.mockResolvedValue({});
    const { result } = renderHook(() => useAlephInstallRequest(), { wrapper });
    act(() => result.current.cancel("c".repeat(32)));
    await waitFor(() =>
      expect(api.postAlephInstallCancel).toHaveBeenCalledWith({
        nonce: "c".repeat(32),
      }),
    );
  });
});
