// @vitest-environment jsdom

import { cleanup, renderHook } from "@testing-library/react";
import { defaultAppTheme, type AppTheme } from "@bb/domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AMBIENT_IDLE_ATTRIBUTE,
  AMBIENT_REST_ATTRIBUTE,
} from "./useAmbientScreenCare";

const config = vi.hoisted(() => ({
  appearance: null as AppTheme | null,
  pairingCalls: 0,
}));

vi.mock("@/hooks/queries/system-queries", () => ({
  useSystemConfig: () => ({
    data: config.appearance ? { appearance: config.appearance } : undefined,
  }),
}));

vi.mock("@/lib/sdk", () => ({
  sdk: {
    theme: {
      musicPairing: async () => {
        config.pairingCalls++;
        return {
          port: 47_615,
          secret: Buffer.from(new Uint8Array(32).fill(9)).toString("base64"),
        };
      },
    },
  },
}));

const {
  musicSignalEnabled,
  musicSignalRevision,
  observeMusicEnvironment,
  useMusicSignal,
} = await import("./useMusicSignal");

const dorcas: AppTheme = {
  ...defaultAppTheme,
  themeId: "dorcas",
  musicMode: true,
  musicSecret: "set",
};

function installMedia(): Record<string, { set(matches: boolean): void }> {
  const controls: Record<string, { set(matches: boolean): void }> = {};
  const queries = new Map<string, MediaQueryList>();
  window.matchMedia = vi.fn((media: string) => {
    const existing = queries.get(media);
    if (existing) return existing;
    let matches = false;
    const listeners = new Set<() => void>();
    const query = {
      get matches() {
        return matches;
      },
      media,
      addEventListener: (_: string, l: () => void) => listeners.add(l),
      removeEventListener: (_: string, l: () => void) => listeners.delete(l),
    } as unknown as MediaQueryList;
    controls[media] = {
      set(next) {
        matches = next;
        for (const listener of listeners) listener();
      },
    };
    queries.set(media, query);
    return query;
  });
  return controls;
}

let visibility: DocumentVisibilityState = "visible";

function setVisibility(next: DocumentVisibilityState): void {
  visibility = next;
  document.dispatchEvent(new Event("visibilitychange"));
}

const sockets: { url: string; closed: boolean }[] = [];

class RecordingWebSocket {
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private readonly record: { url: string; closed: boolean };
  constructor(url: string) {
    this.record = { url, closed: false };
    sockets.push(this.record);
  }
  send(): void {}
  close(): void {
    this.record.closed = true;
  }
}

beforeEach(() => {
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => visibility,
  });
  sockets.length = 0;
  config.pairingCalls = 0;
  vi.stubGlobal("WebSocket", RecordingWebSocket);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  document.documentElement.removeAttribute(AMBIENT_REST_ATTRIBUTE);
  document.documentElement.removeAttribute(AMBIENT_IDLE_ATTRIBUTE);
});

describe("musicSignalEnabled", () => {
  it("requires music mode, the Dorcas theme and a stored secret", () => {
    expect(musicSignalEnabled(dorcas)).toBe(true);
    expect(musicSignalEnabled({ ...dorcas, musicMode: false })).toBe(false);
    expect(musicSignalEnabled({ ...dorcas, themeId: "thecla" })).toBe(false);
    expect(musicSignalEnabled({ ...dorcas, musicSecret: null })).toBe(false);
  });

  it("changes revision with the port and secret status, never the secret", () => {
    expect(musicSignalRevision(dorcas)).toBe("47615:set");
    expect(musicSignalRevision({ ...dorcas, musicPort: 50_000 })).toBe(
      "50000:set",
    );
    expect(musicSignalRevision({ ...dorcas, musicSecret: null })).toBe(
      "47615:unset",
    );
  });
});

describe("observeMusicEnvironment", () => {
  it("reports visibility, suppression and ambient rest or idle", async () => {
    const media = installMedia();
    const seen: unknown[] = [];
    const stop = observeMusicEnvironment(
      window,
      document.documentElement,
      (environment) => seen.push(environment),
    );
    const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
    expect(seen.at(-1)).toEqual({
      visible: true,
      suppressed: false,
      rest: false,
    });
    media["(prefers-reduced-motion: reduce)"].set(true);
    expect(seen.at(-1)).toMatchObject({ suppressed: true });
    media["(prefers-reduced-motion: reduce)"].set(false);
    media["(forced-colors: active)"].set(true);
    expect(seen.at(-1)).toMatchObject({ suppressed: true });
    media["(forced-colors: active)"].set(false);
    setVisibility("hidden");
    expect(seen.at(-1)).toMatchObject({ visible: false, suppressed: false });
    setVisibility("visible");
    document.documentElement.setAttribute(AMBIENT_IDLE_ATTRIBUTE, "");
    await flush();
    expect(seen.at(-1)).toMatchObject({ rest: true });
    document.documentElement.removeAttribute(AMBIENT_IDLE_ATTRIBUTE);
    document.documentElement.setAttribute(AMBIENT_REST_ATTRIBUTE, "");
    await flush();
    expect(seen.at(-1)).toMatchObject({ rest: true });
    const count = seen.length;
    stop();
    setVisibility("hidden");
    media["(forced-colors: active)"].set(true);
    document.documentElement.removeAttribute(AMBIENT_REST_ATTRIBUTE);
    await flush();
    expect(seen).toHaveLength(count);
  });
});

describe("useMusicSignal", () => {
  const flush = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  };

  it("opens nothing unless music mode applies", async () => {
    installMedia();
    for (const appearance of [
      null,
      { ...dorcas, musicMode: false },
      { ...dorcas, themeId: "thecla" },
      { ...dorcas, musicSecret: null },
    ]) {
      config.appearance = appearance;
      const hook = renderHook(() => useMusicSignal());
      await flush();
      hook.unmount();
    }
    expect(config.pairingCalls).toBe(0);
    expect(sockets).toHaveLength(0);
  });

  it("connects to loopback when enabled and closes on unmount", async () => {
    installMedia();
    config.appearance = dorcas;
    const hook = renderHook(() => useMusicSignal());
    await flush();
    expect(config.pairingCalls).toBe(1);
    expect(sockets.map((s) => s.url)).toEqual([
      "ws://127.0.0.1:47615/signal/v1",
    ]);
    hook.unmount();
    expect(sockets[0].closed).toBe(true);
  });

  it("closes the socket when music mode is turned off", async () => {
    installMedia();
    config.appearance = dorcas;
    const hook = renderHook(() => useMusicSignal());
    await flush();
    config.appearance = { ...dorcas, musicMode: false };
    hook.rerender();
    expect(sockets[0].closed).toBe(true);
    hook.unmount();
  });
});
