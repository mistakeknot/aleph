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
  installTestPluginRuntime,
} from "@get-bb/plugin-sdk/testing/app";

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

it.each([
  ["needs_sign_in", true, false, false],
  ["unavailable", true, false, false],
  ["needs_sign_in", false, true, false],
  ["unavailable", false, true, false],
  ["unavailable", true, true, true],
  ["needs_sign_in", false, true, true],
  ["unavailable", false, true, true],
] as const)(
  "marks the failed row for %s with cached quota %s and machine failure %s",
  (refreshFailure, cached, machineFailure, allFailed) => {
    installTestPluginRuntime();
    const account = (label: string, failed: boolean) => ({
      id: `bb--account-pool:${label}`,
      providerId: "claude-code",
      accountLabel: label,
      displayName: "Claude Code",
      logoUrl: null,
      icon: null,
      strings: { iconTint: null },
      signInHint: "Sign in.",
      expiredHint: "Sign in again.",
      ...(failed ? { refreshFailure } : {}),
      usage:
        failed && !cached
          ? null
          : {
              status: "ok" as const,
              accountEmail: null,
              planLabel: null,
              windows: [
                {
                  label: "Weekly",
                  usedPercent: failed ? 80 : 20,
                  resetsAt: null,
                  cost: null,
                },
              ],
            },
    });
    const view = render(
      <ProviderUsageStatusContent
        dismiss={vi.fn()}
        pluginId="bb--provider-usage"
        threadMachineId={null}
        refreshEnabled={false}
        snapshot={{
          error: null,
          isRefreshing: false,
          data: {
            machines: [
              {
                id: "source:pool",
                displayName: "Pool",
                status: "connected",
                error: machineFailure
                  ? "Some usage could not be refreshed."
                  : null,
                providers: [
                  account("Primary", true),
                  account("Secondary", allFailed),
                ],
              },
            ],
          },
        }}
      />,
    );
    const failed = within(view.getByRole("region", { name: "Primary" }));
    expect(failed.queryByText("20% left")).toBeNull();
    expect(
      failed.getByText(
        refreshFailure === "needs_sign_in"
          ? "Signed out: sign in again."
          : "Couldn’t refresh this account. Quota unavailable.",
      ),
    ).toBeTruthy();
    expect(failed.queryByText(/Account Pooler settings/) !== null).toBe(
      refreshFailure === "needs_sign_in",
    );
    expect(view.queryByText("80% left") !== null).toBe(!allFailed);
    expect(
      view.queryByText("Couldn’t refresh. Showing last update.") !== null,
    ).toBe(machineFailure && !allFailed);
    if (allFailed) expect(view.getByText("Couldn’t load usage.")).toBeTruthy();
  },
);

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
    parentNotifications: "auto",
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
            observedAt: Date.now(),
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
          providerIds: string[];
        };
        for (const providerId of request.providerIds)
          for (const machine of machines)
            if (
              request.machineIds === null ||
              request.machineIds.includes(machine.id)
            )
              measured.add(`${machine.id}:${providerId}`);
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
      pluginId: "bb--provider-usage",
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
        "/api/v1/plugins/bb--provider-usage/rpc/getUsage",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            force: false,
            machineIds: null,
            maxAgeMs: 30 * 60_000,
            providerIds: [],
          }),
        }),
      ),
    );
    const dismiss = vi.fn();
    const slot = renderSlot(
      item,
      { dismiss },
      {
        pluginId: "bb--provider-usage",
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
      slot
        .getByRole("tab", { name: "All accounts" })
        .getAttribute("aria-selected"),
    ).toBe("true");
    expect(
      slot.getAllByRole("region").map((row) => row.getAttribute("aria-label")),
    ).toEqual([
      "Codex team@example.com",
      "Codex personal@example.com",
      "Claude Code claude-team@example.com",
    ]);
    expect(
      slot
        .getAllByRole("region")
        .map((row) =>
          row
            .querySelector('[data-provider-kind="agent"]')
            ?.getAttribute("data-provider-id"),
        ),
    ).toEqual(["codex", "codex", "claude-code"]);
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/v1/plugins/bb--provider-usage/rpc/getUsage",
        expect.objectContaining({
          body: JSON.stringify({
            force: false,
            machineIds: ["source:account-pool"],
            maxAgeMs: 2 * 60_000,
            providerIds: ["codex", "claude-code"],
          }),
        }),
      ),
    );
    fireEvent.pointerDown(
      slot.getByRole("button", { name: "Usage machine: Account Pooler" }),
      { button: 0 },
    );
    fireEvent.click(slot.getByRole("menuitemradio", { name: "M5" }));
    const machinePicker = slot.getByRole("button", {
      name: "Usage machine: M5",
    });
    expect(
      await slot.findByRole("heading", { name: "codex@example.com" }),
    ).toBeTruthy();
    expect(slot.getByText("3% left")).toBeTruthy();
    expect(
      localStorage.getItem("bb.bb--provider-usage.selected-machine.v1"),
    ).toBe("host-m5");

    fireEvent.pointerDown(machinePicker, { button: 0 });
    fireEvent.click(slot.getByRole("menuitemradio", { name: "M4" }));
    const allTab = slot.getByRole("tab", { name: "All accounts" });
    const claudeTab = slot.getByRole("tab", { name: "Claude Code" });
    const codexTab = slot.getByRole("tab", { name: "Codex" });
    expect(
      slot
        .getByRole("button", { name: "Usage machine: M4" })
        .closest('[data-provider-usage-header=""]'),
    ).toBe(claudeTab.closest('[data-provider-usage-header=""]'));
    expect(
      claudeTab.querySelector("[data-provider-logo*='claude-code']"),
    ).not.toBeNull();
    expect(
      codexTab.querySelector("[data-provider-logo*='/codex/']"),
    ).not.toBeNull();
    expect(await slot.findByText("claude@example.com")).toBeTruthy();
    expect(slot.getByText("18% left")).toBeTruthy();
    expect(await slot.findByText("codex@example.com")).toBeTruthy();
    expect(slot.getByText("63% left")).toBeTruthy();
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/v1/plugins/bb--provider-usage/rpc/getUsage",
        expect.objectContaining({
          body: JSON.stringify({
            force: false,
            machineIds: ["host-m4"],
            maxAgeMs: 2 * 60_000,
            providerIds: ["claude-code", "codex"],
          }),
        }),
      ),
    );
    const m4Reload = slot.getByRole("button", {
      name: "Reload provider usage",
    }) as HTMLButtonElement;
    await waitFor(() => expect(m4Reload.disabled).toBe(false));
    const callsBeforeM4Reload = fetchMock.mock.calls.length;
    fireEvent.click(m4Reload);
    await waitFor(() =>
      expect(fetchMock.mock.calls.length).toBe(callsBeforeM4Reload + 1),
    );
    expect(
      fetchMock.mock.calls
        .slice(callsBeforeM4Reload)
        .map(([, init]) => JSON.parse(String(init?.body))),
    ).toEqual([
      {
        force: true,
        machineIds: ["host-m4"],
        maxAgeMs: 0,
        providerIds: ["claude-code", "codex"],
      },
    ]);
    await waitFor(() => expect(m4Reload.disabled).toBe(false));

    fireEvent.keyDown(allTab, { key: "ArrowRight" });
    expect(claudeTab.getAttribute("aria-selected")).toBe("true");
    expect(
      slot.getByRole("heading", { name: "claude@example.com" }),
    ).toBeTruthy();
    expect(slot.getByText("18% left")).toBeTruthy();

    fireEvent.click(codexTab);
    expect(
      slot.getByRole("heading", { name: "codex@example.com" }),
    ).toBeTruthy();
    expect(slot.getByText("63% left")).toBeTruthy();
    fireEvent.keyDown(codexTab, { key: "ArrowLeft" });
    expect(claudeTab.getAttribute("aria-selected")).toBe("true");

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
          providerIds: [],
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
          providerIds: [],
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
    expect(slot.getAllByRole("tab")).toHaveLength(3);
    const poolCodexTab = slot.getByRole("tab", { name: "Codex" });
    expect(
      slot.container.querySelector("[data-provider-usage-tone]"),
    ).toBeNull();
    fireEvent.click(poolCodexTab);
    expect(
      poolCodexTab.querySelector("[data-provider-logo*='/codex/']"),
    ).not.toBeNull();
    expect(poolCodexTab.querySelector("[data-provider-usage-tone]")).toBeNull();
    expect(
      slot
        .getByRole("tab", { name: "Claude Code" })
        .querySelector('[data-provider-usage-tone="critical"]'),
    ).not.toBeNull();
    expect(slot.getAllByText("team@example.com")).toHaveLength(1);
    expect(slot.getAllByText("personal@example.com")).toHaveLength(1);
    expect(slot.getByText("54% left")).toBeTruthy();
    expect(
      slot.getAllByRole("heading").map((heading) => heading.textContent),
    ).toEqual(["team@example.com", "personal@example.com"]);
    expect(slot.getByText("18% left")).toBeTruthy();
    expect(
      slot.getByRole("group", {
        name: "Weekly limit: 46% used. Reset time not reported",
      }),
    ).toBeTruthy();
    const pacedWindow = slot.getByRole("group", {
      name: /^Weekly limit: 82% used\. Resets .*\. Cycle average 0\.7%\/hr from one reading · projected to run out in 1d 1h$/u,
    });
    expect(within(pacedWindow).getByText("≈0.7%/h")).toBeTruthy();
    expect(within(pacedWindow).getByText("out 1d 1h")).toBeTruthy();
    expect(within(pacedWindow).queryByText("2d 3h")).toBeNull();
    expect(
      within(pacedWindow).getByTestId("usage-projection").style.width,
    ).toBe("100%");
    fireEvent.pointerMove(pacedWindow, { pointerType: "mouse" });
    await waitFor(() =>
      expect(
        slot.getAllByText(
          "Cycle average 0.7%/hr from one reading · projected to run out in 1d 1h",
        ).length,
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
    fireEvent.click(slot.getByRole("tab", { name: "Claude Code" }));
    expect(slot.getByText("claude-team@example.com")).toBeTruthy();
    expect(slot.getByText("3% left")).toBeTruthy();
    expect(slot.queryByText("personal@example.com")).toBeNull();
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
          slot.getByText("Couldn’t refresh. Showing last update."),
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
          slot.queryByText("Couldn’t refresh. Showing last update."),
        ).toBeNull(),
      );
    }
    expect(diagnostics).toHaveBeenCalledTimes(3);
    await mounted.lifecycle.dispose();
  }, 15_000);
});

it("refreshes the requested providers in one queued call so a late snapshot cannot blank a newer one", async () => {
  const account = (
    providerId: string,
    email: string,
    usedPercent: number,
  ): UsageProvider => ({
    id: `${providerId}:${email}`,
    providerId,
    accountLabel: email,
    displayName: providerId,
    logoUrl: null,
    icon: null,
    strings: { iconTint: null },
    signInHint: "Sign in.",
    expiredHint: "Sign in again.",
    usage: {
      status: "ok",
      accountEmail: email,
      planLabel: null,
      windows: [
        { label: "Weekly limit", usedPercent, resetsAt: null, cost: null },
      ],
    },
  });
  const providers = [
    account("codex", "codex@example.com", 42),
    account("claude", "claude@example.com", 30),
  ];
  const measured = new Set<string>();
  let inFlight = 0;
  let maxInFlight = 0;
  let providerRequests = 0;
  const fetchMock = vi.fn(
    async (_input: RequestInfo | URL, init?: RequestInit) => {
      const { machineIds, providerIds } = JSON.parse(String(init?.body)) as {
        machineIds: string[] | null;
        providerIds: string[];
      };
      const ours = providerIds.length > 0 && machineIds?.[0] === "host-seq";
      if (ours) for (const providerId of providerIds) measured.add(providerId);
      const body = JSON.stringify({
        ok: true,
        result: {
          machines: [
            {
              id: "host-seq",
              displayName: "Sequence",
              status: "connected",
              error: null,
              providers: providers.map((provider) =>
                measured.has(provider.providerId)
                  ? provider
                  : { ...provider, usage: null },
              ),
            },
          ],
        },
      });
      if (!ours)
        return new Response(body, {
          headers: { "content-type": "application/json" },
        });
      providerRequests += 1;
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) =>
        setTimeout(resolve, providerRequests === 1 ? 60 : 5),
      );
      inFlight -= 1;
      return new Response(body, {
        headers: { "content-type": "application/json" },
      });
    },
  );
  vi.stubGlobal("fetch", fetchMock);
  const app = await loadPluginApp(() => import("./app"));
  const mounted = await mountPluginContentScripts(app, {
    pluginId: "bb--provider-usage",
  });
  const item = app.experimentalSidebarFooterItems[0];
  if (item?.kind !== "disclosure") throw new Error("missing disclosure");
  const slot = renderSlot(
    item,
    { dismiss: vi.fn() },
    {
      pluginId: "bb--provider-usage",
      context: { threadId: "thread-active" },
      sidebarThreads: { threads: [threadOnMachine("host-seq", "Sequence")] },
    },
  );
  await waitFor(() => expect(providerRequests).toBe(1));
  await waitFor(() => expect(inFlight).toBe(0));
  await waitFor(() => {
    expect(slot.getByText("58% left")).toBeTruthy();
    expect(slot.getByText("70% left")).toBeTruthy();
  });
  expect(maxInFlight).toBe(1);
  await mounted.lifecycle.dispose();
});

it("queues the focus reconcile with the card refresh so a stale snapshot cannot land last", async () => {
  let usedPercent = 21;
  const snapshot = () =>
    JSON.stringify({
      ok: true,
      result: {
        machines: [
          {
            id: "host-reconcile",
            displayName: "Reconcile",
            status: "connected",
            error: null,
            providers: [
              {
                id: "codex:reconcile@example.com",
                providerId: "codex",
                accountLabel: "reconcile@example.com",
                displayName: "codex",
                logoUrl: null,
                icon: null,
                strings: { iconTint: null },
                signInHint: "Sign in.",
                expiredHint: "Sign in again.",
                usage: {
                  status: "ok",
                  accountEmail: "reconcile@example.com",
                  planLabel: null,
                  windows: [
                    {
                      label: "Weekly limit",
                      usedPercent,
                      resetsAt: null,
                      cost: null,
                    },
                  ],
                },
              },
            ],
          },
        ],
      },
    });
  let afterFocus = false;
  let inFlight = 0;
  let maxInFlight = 0;
  const fetchMock = vi.fn(
    async (_input: RequestInfo | URL, init?: RequestInit) => {
      const { providerIds } = JSON.parse(String(init?.body)) as {
        providerIds: string[];
      };
      if (afterFocus && providerIds.length > 0) usedPercent = 35;
      const body = snapshot();
      if (afterFocus) {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) =>
          setTimeout(resolve, providerIds.length === 0 ? 60 : 5),
        );
        inFlight -= 1;
      }
      return new Response(body, {
        headers: { "content-type": "application/json" },
      });
    },
  );
  vi.stubGlobal("fetch", fetchMock);
  const app = await loadPluginApp(() => import("./app"));
  const mounted = await mountPluginContentScripts(app, {
    pluginId: "bb--provider-usage",
  });
  const item = app.experimentalSidebarFooterItems[0];
  if (item?.kind !== "disclosure") throw new Error("missing disclosure");
  const slot = renderSlot(
    item,
    { dismiss: vi.fn() },
    {
      pluginId: "bb--provider-usage",
      context: { threadId: "thread-active" },
      sidebarThreads: {
        threads: [threadOnMachine("host-reconcile", "Reconcile")],
      },
    },
  );
  await waitFor(() => expect(slot.getByText("79% left")).toBeTruthy());
  const callsBeforeFocus = fetchMock.mock.calls.length;
  window.dispatchEvent(new Event("blur"));
  const now = Date.now();
  vi.spyOn(Date, "now").mockReturnValue(now + 6 * 60_000);
  afterFocus = true;
  window.dispatchEvent(new Event("focus"));
  await waitFor(() =>
    expect(fetchMock.mock.calls.length).toBe(callsBeforeFocus + 2),
  );
  await waitFor(() => expect(inFlight).toBe(0));
  await waitFor(() => expect(slot.getByText("65% left")).toBeTruthy());
  expect(slot.queryByText("79% left")).toBeNull();
  expect(maxInFlight).toBe(1);
  await mounted.lifecycle.dispose();
});

it.each([
  ["empty", "No accounts report usage yet."],
  ["expired", "Sign in again in the source plugin’s settings."],
  [
    "unauthenticated",
    "Sign in to this account in the source plugin’s settings.",
  ],
  ["no-limits", "No usage limits reported for this plan."],
  ["source-error", "Couldn’t refresh. Showing last update."],
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
    pluginId: "bb--provider-usage",
  });
  const item = app.experimentalSidebarFooterItems[0];
  if (item?.kind !== "disclosure") throw new Error("missing disclosure");
  const slot = renderSlot(
    item,
    { dismiss: vi.fn() },
    { pluginId: "bb--provider-usage" },
  );
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
        pluginId="bb--provider-usage"
        threadMachineId={null}
        refreshEnabled={false}
      />,
    );
  }

  it("never scrolls sideways, so a narrow sidebar cannot clip the left edge", () => {
    const view = renderPanel();
    const region = view.getByRole("tabpanel", {
      name: "Account Pooler Claude Code usage",
    });
    expect(region.className).toContain("overflow-x-hidden");
  });

  it("gives every window bar a floor width and drops the burn column before squeezing it", () => {
    const view = renderPanel();
    const rows = view.getAllByRole("group");
    expect(rows).toHaveLength(6);
    const grid = rows[0]!.parentElement!.parentElement!;
    expect(grid.className).toContain("minmax(1.25rem,1fr)");
    expect(grid.className).not.toMatch(/grid-cols-\[max-content_/u);
    expect(within(rows[0]!).getAllByText("—")[0]!.className).toContain(
      "hidden",
    );
  });

  it("shrinks to the footer disclosure's height cap", () => {
    const view = renderPanel();
    const panelClassName = view.container.querySelector(
      "[data-provider-usage-header]",
    )!.parentElement!.className;
    expect(panelClassName).toContain("min-h-0");
    expect(panelClassName).not.toContain("max-h-80");
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
              observedAt: Date.now(),
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
          pluginId="bb--provider-usage"
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
      expect(view.getByRole("tab", { name: "All accounts" })).toBeTruthy();
    });

    it.each([
      [100, 2 * HOUR, 0, "Last reading reached the limit"],
      [20, 2 * HOUR, 61 * 60_000, "Reading is too old to estimate"],
      [20, 0, 5 * 60_000, "Awaiting a reading after reset"],
      [1, 2 * HOUR, 0, "Insufficient quota data to estimate"],
    ] as const)(
      "shows quota without a forecast for %i%% used (%s, %s)",
      (used, reset, age, detail) => {
        const entry = account(
          "claude-code",
          "Claude Code",
          "fixture@example.com",
          used,
          reset,
        );
        if (entry.usage?.status !== "ok")
          throw new Error("Expected an observed quota window");
        entry.usage.windows[0]!.observedAt = Date.now() - age;
        const view = renderAccounts([entry]);
        const row = view.getByRole("group", { name: new RegExp(detail, "u") });
        expect(within(row).getByText(`${100 - used}% left`)).toBeTruthy();
        expect(within(row).queryByText(/%\/h|^out /u)).toBeNull();
        expect(within(row).queryByTestId("usage-projection")).toBeNull();
      },
    );

    it("persists the chosen grouping and restores it on the next mount", () => {
      const grouped = [
        "slow@x.com",
        "none-low@x.com",
        "faster@x.com",
        "none-high@x.com",
        "fast@x.com",
      ];
      const first = renderAccounts(mixed());
      fireEvent.click(
        first.getByRole("button", { name: /sort accounts by soonest/iu }),
      );
      expect(window.localStorage.getItem("bb:provider-usage:sort-mode")).toBe(
        "provider",
      );
      expect(order(first)).toEqual(grouped);
      first.unmount();
      const second = renderAccounts(mixed());
      expect(order(second)).toEqual(grouped);
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

it("keeps a measured refresh when an older snapshot response arrives late", async () => {
  const account = (usage: UsageProvider["usage"]): UsageProvider => ({
    id: "account",
    providerId: "codex",
    accountLabel: "review@example.com",
    displayName: "Codex",
    logoUrl: null,
    icon: null,
    strings: { iconTint: null },
    signInHint: "Sign in.",
    expiredHint: "Sign in again.",
    usage,
  });
  const snapshot = (usage: UsageProvider["usage"]) =>
    Response.json({
      ok: true,
      result: {
        machines: [
          {
            id: "source:pool",
            displayName: "Review pool",
            status: "connected",
            providers: [account(usage)],
            error: null,
          },
        ],
      },
    });
  let releaseInventory: (() => void) | null = null;
  const fetchMock = vi.fn(
    async (_input: RequestInfo | URL, init?: RequestInit) => {
      const { providerIds } = JSON.parse(String(init?.body)) as {
        providerIds: string[];
      };
      if (providerIds.length > 0)
        return snapshot({
          status: "ok",
          accountEmail: "review@example.com",
          planLabel: null,
          windows: [
            {
              label: "Weekly limit",
              usedPercent: 37,
              resetsAt: null,
              cost: null,
            },
          ],
        });
      if (fetchMock.mock.calls.length === 1) return snapshot(null);
      await new Promise<void>((resolve) => {
        releaseInventory = resolve;
      });
      return snapshot(null);
    },
  );
  vi.stubGlobal("fetch", fetchMock);
  const app = await loadPluginApp(() => import("./app"));
  const mounted = await mountPluginContentScripts(app, {
    pluginId: "bb--provider-usage",
  });
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
  window.dispatchEvent(new Event("blur"));
  now.mockReturnValue(5 * 60_000 + 1_001);
  window.dispatchEvent(new Event("focus"));
  await waitFor(() => expect(releaseInventory).not.toBeNull());
  now.mockRestore();

  const item = app.experimentalSidebarFooterItems[0];
  if (item?.kind !== "disclosure") throw new Error("missing disclosure");
  const slot = renderSlot(
    item,
    { dismiss: vi.fn() },
    { pluginId: "bb--provider-usage" },
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  releaseInventory!();
  await waitFor(() => expect(slot.getByText("63% left")).toBeTruthy());
  await waitFor(() =>
    expect(
      slot
        .getByRole("button", { name: "Reload provider usage" })
        .hasAttribute("disabled"),
    ).toBe(false),
  );
  expect(slot.queryByText("Usage not reported.")).toBeNull();
  expect(slot.getByText("63% left")).toBeTruthy();
  await mounted.lifecycle.dispose();
});
