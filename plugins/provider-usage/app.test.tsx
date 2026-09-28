// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UsageMachine, UsageProvider } from "./usage-schema.js";
import { ProviderUsageStatusContent } from "./app.js";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import {
  loadPluginApp,
  mountPluginContentScripts,
  renderSlot,
} from "@get-bb/plugin-sdk/testing/app";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

function threadOnMachine(
  hostId: string,
  hostName: string,
): PluginSidebarThread {
  return {
    id: "thread-active",
    projectId: "project-one",
    title: "Active thread",
    titleFallback: null,
    displayTitle: "Active thread",
    parentThreadId: null,
    lifecycleOwnerThreadId: null,
    sourceThreadId: null,
    sectionId: null,
    originKind: null,
    originPluginId: null,
    providerId: "codex",
    status: "idle",
    runtimeStatus: "idle",
    queuedWork: "none",
    hasPendingInteraction: false,
    activity: {
      workflows: 0,
      backgroundAgents: 0,
      backgroundCommands: 0,
      planMode: 0,
      goals: 0,
    },
    indicator: "none",
    indicatorLabel: null,
    isUnread: false,
    isPinned: false,
    pinnedAt: null,
    pinSortKey: null,
    isArchived: false,
    archivedAt: null,
    href: "/projects/project-one/threads/thread-active",
    isHidden: false,
    environment: null,
    host: { id: hostId, name: hostName },
    createdAt: 1,
    updatedAt: 1,
    lastReadAt: 1,
    latestAttentionAt: 1,
  };
}

describe("provider usage footer disclosure", () => {
  it("aggregates every machine and keeps machine and provider selection local to the card", async () => {
    window.localStorage.setItem("bb:provider-usage:sort-mode", "provider");
    const pooledAccounts: UsageProvider[] = (
      [
        ["codex", "Codex", "team@example.com", 46],
        ["codex", "Codex", "personal@example.com", 82],
        ["claude-code", "Claude Code", "claude-team@example.com", 97],
      ] as const
    ).map(([providerId, displayName, email, usedPercent]) => ({
      id: email,
      providerId: providerId,
      accountLabel: email,
      displayName: displayName,
      logoUrl: `/api/v1/system/providers/${providerId}/logo`,
      icon: null,
      strings: { iconTint: null },
      signInHint: "Sign in.",
      expiredHint: "Sign in again.",
      usage: {
        status: "ok",
        accountEmail: email,
        planLabel: "Pro",
        windows: [
          {
            kind: "weekly",
            label: "Weekly limit",
            usedPercent: usedPercent,
            resetsAt:
              email === "personal@example.com"
                ? new Date(Date.now() + 51 * 60 * 60_000).toISOString()
                : null,
            cost: null,
          },
        ],
      },
    }));
    const machines: UsageMachine[] = [
      {
        id: "host-m4",
        displayName: "M4",
        status: "connected",
        error: null,
        providers: [
          {
            id: "claude-code",
            providerId: "claude-code",
            accountLabel: null,
            displayName: "Claude Code",
            logoUrl: "/api/v1/system/providers/claude-code/logo?h=claude",
            icon: null,
            strings: {
              iconTint: { light: "#D97757", dark: "#E38A6E" },
            },
            signInHint: "Sign in to Claude Code.",
            expiredHint: "Sign in to Claude Code again.",
            usage: {
              status: "ok",
              accountEmail: "claude@example.com",
              planLabel: "Max",
              windows: [
                {
                  label: "Five-hour limit",
                  usedPercent: 82,
                  resetsAt: "2026-09-02T18:42:00.000Z",
                  cost: null,
                },
              ],
            },
          },
          {
            id: "codex",
            providerId: "codex",
            accountLabel: null,
            displayName: "Codex",
            logoUrl: "/api/v1/system/providers/codex/logo?h=codex",
            icon: null,
            strings: { iconTint: null },
            signInHint: "Sign in to Codex.",
            expiredHint: "Sign in to Codex again.",
            usage: {
              status: "ok",
              accountEmail: "codex@example.com",
              planLabel: "Plus",
              windows: [
                {
                  label: "Weekly limit",
                  usedPercent: 37,
                  resetsAt: null,
                  cost: null,
                },
              ],
            },
          },
        ],
      },
      {
        id: "host-m5",
        displayName: "M5",
        status: "connected",
        error: null,
        providers: [
          {
            id: "codex",
            providerId: "codex",
            accountLabel: null,
            displayName: "Codex",
            logoUrl: "/api/v1/system/providers/codex/logo?h=codex",
            icon: null,
            strings: { iconTint: null },
            signInHint: "Sign in to Codex.",
            expiredHint: "Sign in to Codex again.",
            usage: {
              status: "ok",
              accountEmail: "codex@example.com",
              planLabel: "Plus",
              windows: [
                {
                  label: "Weekly limit",
                  usedPercent: 97,
                  resetsAt: null,
                  cost: null,
                },
              ],
            },
          },
        ],
      },
      {
        id: "source:account-pool",
        displayName: "Account Pooler",
        status: "connected",
        error: null,
        providers: pooledAccounts,
      },
      {
        id: "host-intel",
        displayName: "Intel",
        status: "disconnected",
        error: null,
        providers: [],
      },
    ];
    const measured = new Set<string>();
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        const request = JSON.parse(String(init?.body)) as {
          machineIds: string[] | null;
          providerId: string | null;
        };
        if (request.providerId !== null)
          for (const machine of machines)
            if (
              request.machineIds === null ||
              request.machineIds.includes(machine.id)
            )
              measured.add(`${machine.id}:${request.providerId}`);
        return new Response(
          JSON.stringify({
            ok: true,
            result: {
              machines: machines.map((machine) => ({
                ...machine,
                providers: machine.providers.map((provider) =>
                  measured.has(`${machine.id}:${provider.providerId}`)
                    ? provider
                    : { ...provider, usage: null },
                ),
              })),
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const app = await loadPluginApp(() => import("./app"));
    const mounted = await mountPluginContentScripts(app, {
      pluginId: "provider-usage",
    });
    const item = app.experimentalSidebarFooterItems[0];
    expect(item).toMatchObject({
      kind: "disclosure",
      id: "usage",
      label: "Provider usage",
      icon: "ChartColumn",
    });
    if (item?.kind !== "disclosure") throw new Error("missing disclosure");

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/v1/plugins/provider-usage/rpc/getUsage",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            force: false,
            machineIds: null,
            maxAgeMs: 30 * 60_000,
            providerId: null,
          }),
        }),
      ),
    );
    const dismiss = vi.fn();
    const slot = renderSlot(
      item,
      { dismiss },
      {
        context: { threadId: "thread-active" },
        sidebarThreads: {
          threads: [threadOnMachine("host-m5", "M5")],
        },
      },
    );
    expect(
      slot.getByRole("button", { name: "Usage machine: Account Pooler" }),
    ).toBeTruthy();
    expect(
      slot.getByRole("heading", { name: "personal@example.com" }),
    ).toBeTruthy();
    fireEvent.pointerDown(
      slot.getByRole("button", { name: "Usage machine: Account Pooler" }),
      { button: 0 },
    );
    fireEvent.click(slot.getByRole("menuitemradio", { name: "M5" }));
    const machinePicker = slot.getByRole("button", {
      name: "Usage machine: M5",
    });
    expect(slot.getByRole("heading", { name: "Codex" })).toBeTruthy();
    expect(await slot.findByText("codex@example.com")).toBeTruthy();
    expect(slot.getByText("3% left")).toBeTruthy();

    fireEvent.pointerDown(machinePicker, { button: 0 });
    fireEvent.click(slot.getByRole("menuitemradio", { name: "M4" }));
    expect(slot.queryAllByRole("tab")).toHaveLength(0);
    const claudeSection = slot.getByRole("region", { name: "Claude Code" });
    const codexSection = slot.getByRole("region", { name: "Codex" });
    expect(
      claudeSection.querySelector("[data-provider-logo*='claude-code']"),
    ).not.toBeNull();
    expect(
      codexSection.querySelector("[data-provider-logo*='/codex/']"),
    ).not.toBeNull();
    expect(slot.getByRole("heading", { name: "Claude Code" })).toBeTruthy();
    expect(await slot.findByText("claude@example.com")).toBeTruthy();
    expect(slot.getByText("18% left")).toBeTruthy();
    expect(slot.getByRole("heading", { name: "Codex" })).toBeTruthy();
    expect(await slot.findByText("codex@example.com")).toBeTruthy();
    expect(slot.getByText("63% left")).toBeTruthy();
    for (const providerId of ["claude-code", "codex"]) {
      await waitFor(() =>
        expect(fetchMock).toHaveBeenCalledWith(
          "/api/v1/plugins/provider-usage/rpc/getUsage",
          expect.objectContaining({
            body: JSON.stringify({
              force: false,
              machineIds: ["host-m4"],
              maxAgeMs: 2 * 60_000,
              providerId,
            }),
          }),
        ),
      );
    }
    const m4Reload = slot.getByRole("button", {
      name: "Reload provider usage",
    }) as HTMLButtonElement;
    await waitFor(() => expect(m4Reload.disabled).toBe(false));
    const callsBeforeM4Reload = fetchMock.mock.calls.length;
    fireEvent.click(m4Reload);
    expect(m4Reload.disabled).toBe(true);
    await waitFor(() => expect(m4Reload.disabled).toBe(false));
    expect(
      fetchMock.mock.calls
        .slice(callsBeforeM4Reload)
        .map(([, init]) => JSON.parse(String(init?.body))),
    ).toEqual([
      {
        force: true,
        machineIds: ["host-m4"],
        maxAgeMs: 0,
        providerId: "claude-code",
      },
      {
        force: true,
        machineIds: ["host-m4"],
        maxAgeMs: 0,
        providerId: "codex",
      },
    ]);

    fireEvent.pointerDown(
      slot.getByRole("button", { name: "Usage machine: M4" }),
      { button: 0 },
    );
    fireEvent.click(slot.getByRole("menuitemradio", { name: "Intel" }));
    expect(
      slot.getByText(
        "Intel is offline. Usage will refresh when it reconnects.",
      ),
    ).toBeTruthy();
    fireEvent.click(
      slot.getByRole("button", { name: "Collapse provider usage" }),
    );
    expect(dismiss).toHaveBeenCalledOnce();
    const reloadButton = slot.getByRole("button", {
      name: "Reload provider usage",
    }) as HTMLButtonElement;
    await waitFor(() => expect(reloadButton.disabled).toBe(false));
    const callsBeforeManualRefresh = fetchMock.mock.calls.length;
    fireEvent.click(reloadButton);
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledTimes(callsBeforeManualRefresh + 1),
    );
    expect(fetchMock.mock.calls.at(-1)?.[1]).toEqual(
      expect.objectContaining({
        body: JSON.stringify({
          force: true,
          machineIds: ["host-intel"],
          maxAgeMs: 0,
          providerId: null,
        }),
      }),
    );

    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    window.dispatchEvent(new Event("blur"));
    now.mockReturnValue(5 * 60_000 + 1_001);
    const callsBeforeFocus = fetchMock.mock.calls.length;
    window.dispatchEvent(new Event("focus"));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledTimes(callsBeforeFocus + 1),
    );
    expect(fetchMock.mock.calls.at(-1)?.[1]).toEqual(
      expect.objectContaining({
        body: JSON.stringify({
          force: false,
          machineIds: null,
          maxAgeMs: 5 * 60_000,
          providerId: null,
        }),
      }),
    );

    now.mockRestore();
    fireEvent.pointerDown(
      slot.getByRole("button", { name: "Usage machine: Intel" }),
      { button: 0 },
    );
    fireEvent.click(
      slot.getByRole("menuitemradio", { name: "Account Pooler" }),
    );
    const poolCodex = slot.getByRole("region", { name: "Codex" });
    expect(
      poolCodex.querySelector("[data-provider-logo*='/codex/']"),
    ).not.toBeNull();
    expect(
      poolCodex.querySelector('[data-provider-usage-tone="warning"]'),
    ).not.toBeNull();
    expect(
      slot
        .getByRole("region", { name: "Claude Code" })
        .querySelector('[data-provider-usage-tone="critical"]'),
    ).not.toBeNull();
    expect(slot.getAllByText("team@example.com")).toHaveLength(1);
    expect(slot.getAllByText("personal@example.com")).toHaveLength(1);
    expect(slot.getByText("54% left")).toBeTruthy();
    expect(
      slot.getAllByRole("heading").map((heading) => heading.textContent),
    ).toEqual([
      "Codex",
      "team@example.com",
      "personal@example.com",
      "Claude Code",
      "claude-team@example.com",
    ]);
    expect(slot.getByText("18% left")).toBeTruthy();
    expect(slot.getByText("3% left")).toBeTruthy();
    expect(
      slot.getByRole("group", {
        name: "Weekly limit: 46% used. Reset time not reported",
      }),
    ).toBeTruthy();
    const pacedWindow = slot.getByRole("group", {
      name: /^Weekly limit: 82% used\. Resets .*\. Burning 0\.7%\/hr · runs out in 1d 1h$/u,
    });
    expect(within(pacedWindow).getByText("0.7%/h")).toBeTruthy();
    expect(within(pacedWindow).getByText("out 1d 1h")).toBeTruthy();
    expect(within(pacedWindow).queryByText("2d 3h")).toBeNull();
    expect(
      within(pacedWindow).getByTestId("usage-projection").style.width,
    ).toBe("100%");
    fireEvent.pointerMove(pacedWindow, { pointerType: "mouse" });
    await waitFor(() =>
      expect(
        slot.getAllByText("Burning 0.7%/hr · runs out in 1d 1h").length,
      ).toBeGreaterThan(0),
    );
    fireEvent.pointerLeave(pacedWindow, { pointerType: "mouse" });
    const unpacedWindow = slot.getByRole("group", {
      name: "Weekly limit: 46% used. Reset time not reported",
    });
    expect(within(unpacedWindow).getAllByText("—")).toHaveLength(2);
    expect(within(unpacedWindow).queryByTestId("usage-projection")).toBeNull();
    fireEvent.keyDown(document, { key: "Tab" });
    fireEvent.focus(unpacedWindow);
    await waitFor(() =>
      expect(unpacedWindow.getAttribute("data-state")).not.toBe("closed"),
    );
    expect(
      slot.getAllByText("46% used · Reset time not reported").length,
    ).toBeGreaterThan(0);
    fireEvent.blur(unpacedWindow);
    await waitFor(() =>
      expect(unpacedWindow.getAttribute("data-state")).toBe("closed"),
    );
    fireEvent.pointerDown(unpacedWindow, { pointerType: "touch" });
    fireEvent.click(unpacedWindow);
    await waitFor(() =>
      expect(unpacedWindow.getAttribute("data-state")).not.toBe("closed"),
    );
    fireEvent.pointerDown(unpacedWindow, { pointerType: "touch" });
    fireEvent.click(unpacedWindow);
    await waitFor(() =>
      expect(unpacedWindow.getAttribute("data-state")).toBe("closed"),
    );
    const diagnostics = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    for (const failure of [
      () => new Response("bb connect temporarily unavailable", { status: 503 }),
      () => new Response("bb connect is not JSON", { status: 200 }),
      () => Response.json({ ok: true, result: { machines: "invalid" } }),
    ]) {
      await waitFor(() =>
        expect(
          slot
            .getByRole("button", { name: "Reload provider usage" })
            .hasAttribute("disabled"),
        ).toBe(false),
      );
      fetchMock.mockResolvedValueOnce(failure());
      fireEvent.click(
        slot.getByRole("button", { name: "Reload provider usage" }),
      );
      await waitFor(() =>
        expect(
          slot.getByText(
            "Couldn’t refresh usage. Showing the last available update.",
          ),
        ).toBeTruthy(),
      );
      expect(slot.getByText("claude-team@example.com")).toBeTruthy();
      expect(
        slot.queryByText(/Unexpected token|bb connect|invalid JSON/i),
      ).toBeNull();
      fireEvent.click(
        slot.getByRole("button", { name: "Reload provider usage" }),
      );
      await waitFor(() =>
        expect(
          slot.queryByText(
            "Couldn’t refresh usage. Showing the last available update.",
          ),
        ).toBeNull(),
      );
    }
    expect(diagnostics).toHaveBeenCalledTimes(3);
    await mounted.lifecycle.dispose();
  }, 15_000);
});

it.each([
  ["empty", "No accounts report usage yet."],
  ["expired", "Sign in again in the source plugin’s settings."],
  [
    "unauthenticated",
    "Sign in to this account in the source plugin’s settings.",
  ],
  ["no-limits", "No usage limits reported for this plan."],
  [
    "source-error",
    "Couldn’t refresh usage. Showing the last available update.",
  ],
] as const)("renders the %s shared-source state", async (state, expected) => {
  const usage: UsageProvider["usage"] =
    state === "expired" || state === "unauthenticated"
      ? { status: state }
      : {
          status: "ok",
          accountEmail: "review@example.com",
          planLabel: null,
          windows:
            state === "no-limits"
              ? []
              : [
                  {
                    label: "Weekly limit",
                    usedPercent: 42,
                    resetsAt: null,
                    cost: null,
                  },
                ],
        };
  const account: UsageProvider = {
    id: "account",
    providerId: "codex",
    accountLabel: "review@example.com",
    displayName: "Codex",
    logoUrl: null,
    icon: null,
    strings: { iconTint: null },
    signInHint: "Sign in to this account in the source plugin’s settings.",
    expiredHint: "Sign in again in the source plugin’s settings.",
    usage,
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({
        ok: true,
        result: {
          machines: [
            {
              id: "source:pool",
              displayName: "Review pool",
              status: "connected",
              providers: state === "empty" ? [] : [account],
              error: state === "source-error" ? "private backend error" : null,
            },
          ],
        },
      }),
    ),
  );
  const app = await loadPluginApp(() => import("./app"));
  const mounted = await mountPluginContentScripts(app, {
    pluginId: "provider-usage",
  });
  const item = app.experimentalSidebarFooterItems[0];
  if (item?.kind !== "disclosure") throw new Error("missing disclosure");
  const slot = renderSlot(item, { dismiss: vi.fn() });
  await waitFor(() =>
    expect(slot.getByText(expected, { exact: false })).toBeTruthy(),
  );
  if (state === "source-error") {
    expect(slot.getByText("58% left")).toBeTruthy();
    expect(slot.queryByText("private backend error")).toBeNull();
    expect(
      slot.queryByRole("button", { name: "Retry usage refresh" }),
    ).toBeNull();
  }
  await mounted.lifecycle.dispose();
});

describe("provider usage panel layout", () => {
  function claudeAccount(email: string): UsageProvider {
    return {
      id: email,
      providerId: "claude-code",
      accountLabel: email,
      displayName: "Claude Code",
      logoUrl: null,
      icon: null,
      strings: { iconTint: null },
      signInHint: "Sign in.",
      expiredHint: "Sign in again.",
      usage: {
        status: "ok",
        accountEmail: email,
        planLabel: "Max (20x)",
        windows: [
          {
            kind: "five-hour",
            label: "Five-hour limit",
            usedPercent: 0,
            resetsAt: null,
            cost: null,
          },
          {
            kind: "weekly",
            label: "Weekly limit",
            usedPercent: 10,
            resetsAt: null,
            cost: null,
          },
          {
            kind: "weekly",
            label: "Weekly · Fable",
            usedPercent: 0,
            resetsAt: null,
            cost: null,
          },
        ],
      },
    };
  }

  function renderPanel() {
    const machine: UsageMachine = {
      id: "source:pool",
      displayName: "Account Pooler",
      status: "connected",
      providers: [
        claudeAccount("a@example.com"),
        claudeAccount("b@example.com"),
      ],
      error: null,
    };
    return render(
      <ProviderUsageStatusContent
        dismiss={vi.fn()}
        snapshot={{
          data: { machines: [machine] },
          error: null,
          isRefreshing: false,
        }}
        threadMachineId={null}
        refreshEnabled={false}
      />,
    );
  }

  it("never scrolls sideways, so a narrow sidebar cannot clip the left edge", () => {
    const view = renderPanel();
    const region = view.getByRole("region", { name: "Account Pooler usage" });
    expect(region.className).toContain("overflow-x-hidden");
  });

  it("gives every window bar a floor width and drops the burn column before squeezing it", () => {
    const view = renderPanel();
    const rows = view.getAllByRole("group");
    expect(rows).toHaveLength(6);
    const grid = rows[0]!.parentElement!;
    expect(grid.className).toContain("minmax(1.25rem,1fr)");
    expect(grid.className).not.toMatch(/grid-cols-\[max-content_/u);
    expect(within(rows[0]!).getAllByText("—")[0]!.className).toContain(
      "hidden",
    );
  });

  it("caps the panel at a height that fits four accounts", () => {
    const view = renderPanel();
    expect(
      view.container.querySelector("[data-provider-usage-header]")!
        .parentElement!.className,
    ).toContain("max-h-96");
  });

  describe("sort order", () => {
    const HOUR = 60 * 60_000;

    function account(
      providerId: string,
      displayName: string,
      email: string,
      usedPercent: number,
      resetsInMs: number | null,
      kind: "five-hour" | "weekly" = "weekly",
    ): UsageProvider {
      return {
        ...claudeAccount(email),
        providerId,
        displayName,
        usage: {
          status: "ok",
          accountEmail: email,
          planLabel: null,
          windows: [
            {
              kind,
              label: "Weekly limit",
              usedPercent,
              resetsAt:
                resetsInMs === null
                  ? null
                  : new Date(Date.now() + resetsInMs).toISOString(),
              cost: null,
            },
          ],
        },
      };
    }

    function renderAccounts(accounts: UsageProvider[]) {
      return render(
        <ProviderUsageStatusContent
          dismiss={vi.fn()}
          snapshot={{
            data: {
              machines: [
                {
                  id: "source:pool",
                  displayName: "Account Pooler",
                  status: "connected",
                  providers: accounts,
                  error: null,
                },
              ],
            },
            error: null,
            isRefreshing: false,
          }}
          threadMachineId={null}
          refreshEnabled={false}
        />,
      );
    }

    const mixed = () => [
      account("claude-code", "Claude Code", "slow@x.com", 40, 6 * 24 * HOUR),
      account("codex", "Codex", "none-high@x.com", 90, null),
      account("codex", "Codex", "fast@x.com", 50, 6 * 24 * HOUR),
      account("claude-code", "Claude Code", "none-low@x.com", 10, null),
      account("claude-code", "Claude Code", "faster@x.com", 80, 6 * 24 * HOUR),
    ];

    function order(view: ReturnType<typeof render>): string[] {
      return view
        .getAllByRole("heading", { level: 3 })
        .map((heading) => heading.textContent ?? "");
    }

    it("defaults to soonest-to-run-out across providers, with unprojected accounts last by lowest remaining", () => {
      const view = renderAccounts(mixed());
      expect(order(view)).toEqual([
        "faster@x.com",
        "fast@x.com",
        "slow@x.com",
        "none-high@x.com",
        "none-low@x.com",
      ]);
      expect(view.queryAllByRole("heading", { level: 2 })).toHaveLength(0);
    });

    it("persists the chosen grouping and restores it on the next mount", () => {
      const first = renderAccounts(mixed());
      fireEvent.click(
        first.getByRole("button", { name: /sort accounts by soonest/iu }),
      );
      expect(window.localStorage.getItem("bb:provider-usage:sort-mode")).toBe(
        "provider",
      );
      expect(first.getAllByRole("heading", { level: 2 })).toHaveLength(2);
      first.unmount();
      const second = renderAccounts(mixed());
      expect(second.getAllByRole("heading", { level: 2 })).toHaveLength(2);
      fireEvent.click(
        second.getByRole("button", { name: /sort accounts by soonest/iu }),
      );
      expect(window.localStorage.getItem("bb:provider-usage:sort-mode")).toBe(
        "exhaustion",
      );
      expect(order(second)[0]).toBe("faster@x.com");
    });
  });
});
