// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { OAuthGrantView } from "@/server/oauth";
import { AppList } from "./dashboard-devices";

vi.mock("@/server/fns", () => ({
  checkAvailabilityFn: vi.fn(() => {
    throw new Error("Unexpected availability check in connected app rows");
  }),
}));

const NOW = Date.UTC(2026, 5, 17, 12);

function grant(overrides: Partial<OAuthGrantView> = {}): OAuthGrantView {
  return {
    id: "grant-a",
    clientId: "client-a",
    clientName: "Client A",
    serverId: "server-a",
    serverHandle: "primary",
    scope: "bb",
    createdAt: NOW - 2 * 24 * 60 * 60 * 1000,
    lastUsedAt: null,
    ...overrides,
  };
}

function buttonNamed(scope: Element, name: string): HTMLButtonElement {
  const button = Array.from(scope.querySelectorAll("button")).find(
    (element) =>
      (element.getAttribute("aria-label") ?? element.textContent)?.trim() ===
      name,
  );
  if (!button) throw new Error(`Missing button: ${name}`);
  return button;
}

function rowNamed(container: Element, name: string): HTMLElement {
  const label = Array.from(container.querySelectorAll("span")).find(
    (element) => element.textContent === name,
  );
  const row = label?.parentElement;
  if (!row) throw new Error(`Missing app row: ${name}`);
  return row;
}

describe("dashboard connected apps", () => {
  let container: HTMLDivElement;
  let root: Root | undefined;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    act(() => root?.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function render(
    grants: OAuthGrantView[],
    onRevoke: (value: OAuthGrantView) => Promise<void> = async () => undefined,
  ): void {
    root = createRoot(container);
    act(() => root?.render(<AppList grants={grants} onRevoke={onRevoke} />));
  }

  it("renders nothing when there are no grants", () => {
    render([]);

    expect(container.innerHTML).toBe("");
  });

  it("shows each app's client, server and status on its own row", () => {
    render([
      grant(),
      grant({
        id: "grant-b",
        clientId: "client-b",
        clientName: "Client B",
        serverId: "server-b",
        serverHandle: "secondary",
        lastUsedAt: NOW - 24 * 60 * 60 * 1000,
      }),
    ]);

    const first = rowNamed(container, "Client A · primary");
    const second = rowNamed(container, "Client B · secondary");
    expect(first.textContent).toContain("Never used");
    expect(first.textContent).not.toContain("Yesterday");
    expect(second.textContent).toContain("Yesterday");
    expect(second.textContent).not.toContain("Never used");
    expect(buttonNamed(first, "More").disabled).toBe(false);
    expect(buttonNamed(second, "More").disabled).toBe(false);
  });

  it("keeps a pending disconnect confirmed until it resolves without disabling other apps", async () => {
    const firstGrant = grant();
    const secondGrant = grant({
      id: "grant-b",
      clientId: "client-b",
      clientName: "Client B",
      serverId: "server-b",
      serverHandle: "secondary",
    });
    const pending = Promise.withResolvers<void>();
    const onRevoke = vi.fn(() => pending.promise);
    render([firstGrant, secondGrant], onRevoke);

    const first = rowNamed(container, "Client A · primary");
    const second = rowNamed(container, "Client B · secondary");
    act(() => buttonNamed(first, "More").click());
    act(() => buttonNamed(first, "Disconnect…").click());
    const confirmation = container.querySelector("h4")?.parentElement;
    if (!confirmation) throw new Error("Missing disconnect confirmation");
    const scrim = confirmation.parentElement;
    if (!scrim) throw new Error("Missing disconnect scrim");
    expect(confirmation.textContent).toContain("Disconnect Client A?");

    try {
      await act(async () => buttonNamed(confirmation, "Disconnect").click());

      expect(onRevoke).toHaveBeenCalledExactlyOnceWith(firstGrant);
      expect(buttonNamed(confirmation, "Cancel").disabled).toBe(true);
      expect(buttonNamed(confirmation, "Removing…").disabled).toBe(true);
      act(() => buttonNamed(confirmation, "Cancel").click());
      act(() => buttonNamed(confirmation, "Removing…").click());
      act(() => scrim.click());
      expect(container.contains(confirmation)).toBe(true);
      expect(container.querySelector("h4")?.textContent).toBe(
        "Disconnect Client A?",
      );
      expect(onRevoke).toHaveBeenCalledExactlyOnceWith(firstGrant);
      expect(buttonNamed(second, "More").disabled).toBe(false);
      act(() => buttonNamed(second, "More").click());
      expect(buttonNamed(second, "Disconnect…").disabled).toBe(false);
    } finally {
      await act(async () => {
        pending.resolve();
        await pending.promise;
      });
    }
    expect(container.querySelector("h4")).toBeNull();
    expect(onRevoke).toHaveBeenCalledExactlyOnceWith(firstGrant);
  });
});
