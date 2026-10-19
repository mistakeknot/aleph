// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { defaultAppTheme, type AppTheme } from "@bb/domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setMusicSignalStatus } from "@/lib/music/music-signal-status";

const calls = vi.hoisted(() => ({
  secrets: [] as (string | null)[],
  fail: false,
  toasts: [] as string[],
}));

vi.mock("@/lib/sdk", () => ({
  sdk: {
    theme: {
      setMusicSecret: async ({ secret }: { secret: string | null }) => {
        calls.secrets.push(secret);
        if (calls.fail) throw new Error("server said no");
        return { musicSecret: secret === null ? null : "set" };
      },
    },
  },
}));

vi.mock("@/lib/mutation-errors", () => ({
  showMutationErrorToast: ({ fallbackMessage }: { fallbackMessage: string }) =>
    calls.toasts.push(fallbackMessage),
}));

const {
  describeMusicSignalStatus,
  MUSIC_MODE_SETTING_LABEL,
  MUSIC_PORT_SETTING_LABEL,
  MUSIC_SECRET_SETTING_LABEL,
  MusicModeSettings,
} = await import("./MusicModeSettings");

const SECRET = Buffer.from(
  Array.from({ length: 32 }, (_, i) => (i * 53 + 7) % 256),
).toString("base64");

const dorcas: AppTheme = {
  ...defaultAppTheme,
  themeId: "dorcas",
  musicMode: true,
};

let consoleSpies: ReturnType<typeof vi.spyOn>[] = [];

beforeEach(() => {
  calls.secrets.length = 0;
  calls.toasts.length = 0;
  calls.fail = false;
  consoleSpies = (["log", "info", "warn", "error", "debug"] as const).map(
    (method) => vi.spyOn(console, method),
  );
});

afterEach(() => {
  cleanup();
  for (const spy of consoleSpies) spy.mockRestore();
  setMusicSignalStatus({ kind: "off" });
});

function renderSettings(appearance: AppTheme) {
  const onSelectionChange = vi.fn();
  const client = new QueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const view = render(
    <MusicModeSettings
      appearance={appearance}
      disabled={false}
      onSelectionChange={onSelectionChange}
    />,
    { wrapper },
  );
  return { onSelectionChange, view };
}

function secretInput(): HTMLInputElement {
  const input = screen.getByLabelText(MUSIC_SECRET_SETTING_LABEL);
  if (!(input instanceof HTMLInputElement)) throw new Error("not an input");
  return input;
}

function expectSecretNowhere(container: HTMLElement): void {
  expect(container.outerHTML).not.toContain(SECRET);
  expect(secretInput().value).not.toContain(SECRET);
  for (const spy of consoleSpies) {
    expect(JSON.stringify(spy.mock.calls)).not.toContain(SECRET);
  }
  expect(JSON.stringify(calls.toasts)).not.toContain(SECRET);
}

describe("describeMusicSignalStatus", () => {
  it("explains why music mode is idle before reporting the connection", () => {
    expect(
      describeMusicSignalStatus(
        { ...dorcas, musicMode: false },
        {
          kind: "connected",
        },
      ),
    ).toBe("Off.");
    expect(
      describeMusicSignalStatus(
        { ...dorcas, themeId: "thecla" },
        { kind: "off" },
      ),
    ).toContain("only affects the Dorcas palette");
    expect(describeMusicSignalStatus(dorcas, { kind: "off" })).toContain(
      "waiting for a pairing secret",
    );
    const paired: AppTheme = { ...dorcas, musicSecret: "set" };
    expect(describeMusicSignalStatus(paired, { kind: "connected" })).toBe(
      "Connected to Phosphene.",
    );
    expect(
      describeMusicSignalStatus(paired, {
        kind: "retrying",
        reason: "handshake timed out",
        retryInMs: 4000,
      }),
    ).toBe("Not connected (handshake timed out). Retrying in 4 s.");
    expect(describeMusicSignalStatus(paired, { kind: "paused" })).toContain(
      "reduced motion",
    );
  });
});

describe("MusicModeSettings", () => {
  it("toggles music mode through the appearance selection", () => {
    const { onSelectionChange } = renderSettings({
      ...dorcas,
      musicMode: false,
    });
    expect(screen.queryByLabelText(MUSIC_PORT_SETTING_LABEL)).toBeNull();
    fireEvent.click(
      screen.getByRole("switch", { name: MUSIC_MODE_SETTING_LABEL }),
    );
    expect(onSelectionChange).toHaveBeenCalledWith({ musicMode: true });
  });

  it("shows the live connection status", () => {
    renderSettings({ ...dorcas, musicSecret: "set" });
    act(() => setMusicSignalStatus({ kind: "connected" }));
    expect(screen.getByText(/Connected to Phosphene\./)).toBeDefined();
  });

  it("commits only valid ports", () => {
    const { onSelectionChange } = renderSettings(dorcas);
    const port = screen.getByLabelText(MUSIC_PORT_SETTING_LABEL);
    fireEvent.change(port, { target: { value: "80" } });
    expect(screen.getByRole("alert").textContent).toContain("1024 to 65535");
    fireEvent.blur(port);
    expect(onSelectionChange).not.toHaveBeenCalled();
    fireEvent.change(port, { target: { value: "50000" } });
    fireEvent.keyDown(port, { key: "Enter" });
    expect(onSelectionChange).toHaveBeenCalledWith({ musicPort: 50_000 });
  });

  it("rejects a malformed secret without sending it", async () => {
    const { view } = renderSettings(dorcas);
    fireEvent.change(secretInput(), { target: { value: "not-a-secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain(
        "not a Phosphene pairing secret",
      ),
    );
    expect(calls.secrets).toEqual([]);
    expect(view.container.outerHTML).not.toContain("not-a-secret");
  });

  it("saves a pasted secret, clears the field and never echoes it", async () => {
    const { view } = renderSettings(dorcas);
    fireEvent.change(secretInput(), { target: { value: ` ${SECRET}\n` } });
    expect(secretInput().type).toBe("password");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls.secrets).toEqual([SECRET]));
    await waitFor(() => expect(secretInput().value).toBe(""));
    expectSecretNowhere(view.container);
  });

  it("saves a secret read from a chosen file", async () => {
    const { view } = renderSettings(dorcas);
    const file = new File([`${SECRET}\n`], "phosphene-secret.txt");
    fireEvent.change(screen.getByLabelText("Pairing secret file"), {
      target: { files: [file] },
    });
    await waitFor(() => expect(calls.secrets).toEqual([SECRET]));
    expectSecretNowhere(view.container);
  });

  it("keeps the secret out of the error toast when the server refuses it", async () => {
    calls.fail = true;
    const { view } = renderSettings(dorcas);
    fireEvent.change(secretInput(), { target: { value: SECRET } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(calls.toasts).toEqual([
        "Failed to save the music pairing secret.",
      ]),
    );
    expect(view.container.outerHTML).not.toContain(SECRET);
    for (const spy of consoleSpies) {
      expect(JSON.stringify(spy.mock.calls)).not.toContain(SECRET);
    }
  });

  it("clears a stored secret", async () => {
    renderSettings({ ...dorcas, musicSecret: "set" });
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    await waitFor(() => expect(calls.secrets).toEqual([null]));
  });

  it("cannot clear when no secret is stored", () => {
    renderSettings(dorcas);
    const clear = screen.getByRole("button", { name: "Clear" });
    expect(clear).toHaveProperty("disabled", true);
  });
});
