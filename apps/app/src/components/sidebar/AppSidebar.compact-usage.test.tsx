// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { createStore, Provider } from "jotai";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompactViewportOverrideProvider } from "@bb/shared-ui/hooks/use-compact-viewport";
import { TooltipProvider } from "@bb/shared-ui/tooltip";
import { SidebarTrigger, SidebarProvider } from "@/components/ui/sidebar";
import {
  markPluginFrontendsSettled,
  resetPluginFrontendBootStateForTest,
} from "@/lib/plugin-frontend-boot-state";
import {
  setPluginSlotRegistrations,
  resetPluginSlotStoreForTest,
  removePluginSlotRegistrations,
} from "@/lib/plugin-slots";
import { registerNavigationPlugin } from "@/test/fixtures/navigation-plugin";
import {
  collectPluginAppRegistrations,
  definePluginApp,
} from "@/lib/plugin-app-definition";
import {
  sidebarFooterHiddenAtom,
  sidebarFooterCapacityAtom,
} from "./sidebarFooterPreferences";
import { observeSharedResize } from "@bb/shared-ui/lib/shared-resize-observer";
import { SIDEBAR_RAIL_BUTTON_CLASS } from "@bb/shared-ui/sidebar-row-classes";
import { NAV_RAIL_COLLAPSED_SIDEBAR_WIDTH } from "./navRailWidth";
import { AppSidebar } from "./AppSidebar";
import {
  sidebarNavigationProviderAtom,
  useResolvedSidebarNavigation,
} from "./sidebarNavigationProvider";

vi.mock("@/components/commands/AppCommandProvider", () => ({
  useAppCommandHandler: () => {},
  useAppCommandRunner: () => ({
    dispatch: () => {},
    isCommandAvailable: () => true,
  }),
  useAppCommandShortcut: () => null,
  useAppCommandShortcuts: () => [],
  useIndexedAppCommandHandlers: () => {},
  useIsAppCommandModifierHeld: () => false,
}));

vi.mock("./PluginThreadList", () => ({
  PluginThreadList: () => <div data-testid="thread-list" />,
}));

vi.mock("./SidebarPluginAttentionGlyph", () => ({
  SidebarPluginAttentionGlyph: () => null,
}));

vi.mock("./SidebarUpdatesBadge", () => ({
  SidebarUpdatesBadge: () => null,
}));

vi.mock("./LazySidebarFooterCustomize", () => ({
  LazySidebarFooterCustomize: ({ onDone }: { onDone(): void }) => (
    <button onClick={onDone}>Done customizing footer</button>
  ),
}));

vi.mock("@bb/shared-ui/lib/shared-resize-observer", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@bb/shared-ui/lib/shared-resize-observer")
    >();
  return { ...actual, observeSharedResize: vi.fn(actual.observeSharedResize) };
});

function Harness() {
  const navigation = useResolvedSidebarNavigation();
  return (
    <AppSidebar
      onResizeMouseDown={() => {}}
      isResizing={false}
      isBodyHidden={false}
      navigation={navigation}
      settingsRoutePath="/settings"
      isSettingsActive={false}
      alternateBody={null}
    />
  );
}

function renderSidebar(
  preference: string,
  framed = false,
  hidden: string[] = [],
  options: { open?: boolean; capacity?: number; compact?: boolean } = {},
) {
  const store = createStore();
  store.set(sidebarNavigationProviderAtom, preference);
  store.set(sidebarFooterHiddenAtom, hidden);
  store.set(sidebarFooterCapacityAtom, options.capacity ?? null);
  render(
    <Provider store={store}>
      <MemoryRouter initialEntries={["/"]}>
        <CompactViewportOverrideProvider
          isCompactViewport={options.compact ?? false}
        >
          <TooltipProvider delayDuration={0}>
            <SidebarProvider
              framed={framed}
              defaultOpen={options.open ?? false}
              collapsedRailWidth={NAV_RAIL_COLLAPSED_SIDEBAR_WIDTH}
            >
              <Harness />
              <SidebarTrigger />
            </SidebarProvider>
          </TooltipProvider>
        </CompactViewportOverrideProvider>
      </MemoryRouter>
    </Provider>,
  );
  return store;
}

function registerUsage() {
  setPluginSlotRegistrations(
    "bb--provider-usage",
    collectPluginAppRegistrations(
      definePluginApp((app) => {
        app.experimental_sidebarFooter.register({
          kind: "disclosure",
          id: "usage",
          label: "Provider usage",
          icon: "ChartColumn",
          component: () => (
            <div>
              <p>Usage accounts</p>
              <button tabIndex={-1}>Inactive action</button>
              <button hidden>Hidden action</button>
              <button disabled>Disabled action</button>
              <button>First usage action</button>
              <button>Last usage action</button>
            </div>
          ),
        });
      }),
    ),
  );
}

beforeEach(async () => {
  window.localStorage.clear();
  resetPluginFrontendBootStateForTest();
  markPluginFrontendsSettled();
  await registerNavigationPlugin();
});

afterEach(async () => {
  await act(async () => {
    cleanup();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  resetPluginSlotStoreForTest();
  resetPluginFrontendBootStateForTest();
  window.localStorage.clear();
});

describe("collapsed sidebar usage", () => {
  it("places the shared usage button above settings and opens an unclipped panel, restoring focus on Escape", () => {
    registerUsage();
    renderSidebar("navigation/rail", true);
    const usage = screen.getByRole("button", { name: "Provider usage" });
    const settings = screen.getByRole("button", { name: "Settings" });
    expect(
      usage
        .closest("[data-compact-sidebar-usage]")
        ?.nextElementSibling?.contains(settings),
    ).toBe(true);
    usage.focus();
    expect(document.activeElement).toBe(usage);
    fireEvent.click(usage);
    expect(usage.getAttribute("aria-expanded")).toBe("true");
    const panel = screen.getByRole("region", { name: "Provider usage" });
    expect(panel.textContent).toContain("Usage accounts");
    expect(panel.closest("[data-sidebar]")).toBeNull();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByText("Usage accounts")).toBeNull();
    expect(document.activeElement).toBe(usage);
  });

  it("previews the shared panel on mouse hover", async () => {
    registerUsage();
    renderSidebar("navigation/rail", true);
    const usage = screen.getByRole("button", { name: "Provider usage" });
    usage.focus();
    fireEvent.pointerOver(usage, { pointerType: "mouse" });
    await waitFor(() =>
      expect(screen.getByText("Usage accounts")).toBeDefined(),
    );
    expect(usage.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(usage);
  });

  it.each([false, true])(
    "omits usage when unavailable or hidden (registered: %s)",
    (registered) => {
      if (registered) registerUsage();
      renderSidebar("navigation/rail", true, [
        "plugin:bb--provider-usage/usage",
      ]);
      expect(
        screen.queryByRole("button", { name: "Provider usage" }),
      ).toBeNull();
      expect(screen.getByRole("button", { name: "Settings" })).toBeDefined();
    },
  );
  it("opens customization from the compact context menu and keeps usage usable afterward", async () => {
    registerUsage();
    renderSidebar("navigation/rail", true);
    fireEvent.click(screen.getByRole("button", { name: "Provider usage" }));
    fireEvent.contextMenu(
      screen.getByRole("button", { name: "Provider usage" }).closest("li")!,
    );
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Customize footer" }),
    );
    const done = await screen.findByRole("button", {
      name: "Done customizing footer",
    });
    expect(done.closest("[inert]")).toBeNull();
    expect(screen.queryByText("Usage accounts")).toBeNull();
    fireEvent.click(done);
    fireEvent.click(screen.getByRole("button", { name: "Toggle Sidebar" }));
    const usage = screen.getByRole("button", { name: "Provider usage" });
    expect(usage.closest("[data-compact-sidebar-usage]")).not.toBeNull();
    fireEvent.click(usage);
    expect(screen.getByText("Usage accounts")).toBeDefined();
  });

  it("moves keyboard focus into the pinned panel and supports Tab from the trigger", () => {
    registerUsage();
    renderSidebar("navigation/rail", true);
    const usage = screen.getByRole("button", { name: "Provider usage" });
    usage.focus();
    fireEvent.click(usage, { detail: 0 });
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "First usage action" }),
    );
    usage.focus();
    fireEvent.keyDown(usage, { key: "Tab" });
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "First usage action" }),
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(document.activeElement).toBe(usage);
  });

  it("keeps expanded rail usage in the footer without moving focus into the panel", () => {
    registerUsage();
    renderSidebar("navigation/rail", true, [], { open: true });
    const usage = screen.getByRole("button", { name: "Provider usage" });
    expect(usage.closest("[data-compact-sidebar-usage]")).toBeNull();
    expect(usage.closest('[data-sidebar="footer"]')).not.toBeNull();
    usage.focus();
    fireEvent.click(usage);
    expect(document.activeElement).toBe(usage);
    expect(
      screen
        .getByRole("region", { name: "Provider usage" })
        .closest("[data-sidebar]"),
    ).not.toBeNull();
  });

  it("does not put overflowed usage in the compact rail and keeps it in expanded More", async () => {
    registerUsage();
    renderSidebar("navigation/rail", true, [], { capacity: 1 });
    expect(screen.queryByRole("button", { name: "Provider usage" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Toggle Sidebar" }));
    const more = screen.getByRole("button", { name: "More footer actions" });
    fireEvent.pointerDown(more, {
      button: 0,
      ctrlKey: false,
      pointerType: "mouse",
    });
    const item = await screen.findByRole("menuitem", {
      name: "Provider usage",
    });
    fireEvent.pointerUp(more, { button: 0, pointerType: "mouse" });
    fireEvent.click(item);
    await screen.findByText("Usage accounts");
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(document.activeElement).toBe(more));
  });

  it("keeps usage in the footer for list navigation", () => {
    registerUsage();
    renderSidebar("navigation/top-list", true);
    expect(document.querySelector("[data-compact-sidebar-usage]")).toBeNull();
    expect(
      screen
        .getByRole("button", { name: "Provider usage" })
        .closest('[data-sidebar="footer"]'),
    ).not.toBeNull();
  });

  it("uses the neighbouring rail button styling and a right-hand tooltip", async () => {
    registerUsage();
    renderSidebar("navigation/rail", true);
    const usage = screen.getByRole("button", { name: "Provider usage" });
    for (const token of SIDEBAR_RAIL_BUTTON_CLASS.split(" "))
      expect(usage.classList.contains(token)).toBe(true);
    expect(usage.classList.contains("justify-center")).toBe(true);
    act(() => usage.focus());
    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip.closest("[data-side]")?.getAttribute("data-side")).toBe(
      "right",
    );
  });

  it("updates floating position when the trigger or its ancestors resize without a window resize", () => {
    registerUsage();
    renderSidebar("navigation/rail", true);
    const usage = screen.getByRole("button", { name: "Provider usage" });
    const bounds = vi
      .spyOn(usage, "getBoundingClientRect")
      .mockReturnValue(new DOMRect(10, 200, 24, 24));
    fireEvent.click(usage);
    const panel = screen.getByRole("region", { name: "Provider usage" });
    expect(panel.parentElement?.style.left).toBe("42px");
    const observer = vi
      .mocked(observeSharedResize)
      .mock.calls.find(
        ([targets]) => Array.isArray(targets) && targets.includes(usage),
      );
    expect(observer).toBeDefined();
    bounds.mockReturnValue(new DOMRect(30, 300, 24, 24));
    act(() => {
      const phases = observer![1];
      phases.write(phases.read(undefined));
    });
    expect(panel.parentElement?.style.left).toBe("62px");
    expect(panel.parentElement?.style.bottom).toBe(
      `${window.innerHeight - 324}px`,
    );
    bounds.mockRestore();
  });

  it("does not float a different plugin disclosure opened by command while collapsed", () => {
    registerUsage();
    let openOther = () => {};
    setPluginSlotRegistrations(
      "other-plugin",
      collectPluginAppRegistrations(
        definePluginApp((app) => {
          const controller = app.experimental_sidebarFooter.register({
            kind: "disclosure",
            id: "other",
            label: "Other disclosure",
            icon: "Info",
            component: () => <p>Other accounts</p>,
          });
          openOther = () => controller.open();
        }),
      ),
    );
    renderSidebar("navigation/rail", true);
    act(() => openOther());
    const panel = screen.getByRole("region", {
      name: "Other disclosure",
      hidden: true,
    });
    expect(panel.closest("[data-sidebar]")).not.toBeNull();
  });
  it("does not add a compact rail usage button on a mobile viewport", () => {
    registerUsage();
    renderSidebar("navigation/rail", true, [], { compact: true });
    expect(document.querySelector("[data-compact-sidebar-usage]")).toBeNull();
  });

  it("removes the compact button and panel when usage is hidden after opening", () => {
    registerUsage();
    const store = renderSidebar("navigation/rail", true);
    fireEvent.click(screen.getByRole("button", { name: "Provider usage" }));
    act(() =>
      store.set(sidebarFooterHiddenAtom, ["plugin:bb--provider-usage/usage"]),
    );
    expect(screen.queryByRole("button", { name: "Provider usage" })).toBeNull();
    expect(screen.queryByText("Usage accounts")).toBeNull();
  });

  it("removes the compact button and panel when the usage plugin unregisters", () => {
    registerUsage();
    renderSidebar("navigation/rail", true);
    fireEvent.click(screen.getByRole("button", { name: "Provider usage" }));
    act(() => removePluginSlotRegistrations("bb--provider-usage"));
    expect(screen.queryByRole("button", { name: "Provider usage" })).toBeNull();
    expect(screen.queryByText("Usage accounts")).toBeNull();
  });
});
