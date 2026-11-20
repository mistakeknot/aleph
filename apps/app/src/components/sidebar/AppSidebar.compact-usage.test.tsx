// @vitest-environment jsdom
import {
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
import { SidebarProvider } from "@/components/ui/sidebar";
import {
  markPluginFrontendsSettled,
  resetPluginFrontendBootStateForTest,
} from "@/lib/plugin-frontend-boot-state";
import {
  setPluginSlotRegistrations,
  resetPluginSlotStoreForTest,
} from "@/lib/plugin-slots";
import { registerNavigationPlugin } from "@/test/fixtures/navigation-plugin";
import {
  collectPluginAppRegistrations,
  definePluginApp,
} from "@/lib/plugin-app-definition";
import { sidebarFooterHiddenAtom } from "./sidebarFooterPreferences";
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
) {
  const store = createStore();
  store.set(sidebarNavigationProviderAtom, preference);
  store.set(sidebarFooterHiddenAtom, hidden);
  render(
    <Provider store={store}>
      <MemoryRouter initialEntries={["/"]}>
        <CompactViewportOverrideProvider isCompactViewport={false}>
          <TooltipProvider>
            <SidebarProvider
              framed={framed}
              defaultOpen={false}
              collapsedRailWidth={NAV_RAIL_COLLAPSED_SIDEBAR_WIDTH}
            >
              <Harness />
            </SidebarProvider>
          </TooltipProvider>
        </CompactViewportOverrideProvider>
      </MemoryRouter>
    </Provider>,
  );
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
          component: () => <p>Usage accounts</p>,
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

afterEach(() => {
  cleanup();
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
    fireEvent.pointerOver(usage, { pointerType: "mouse" });
    await waitFor(() =>
      expect(screen.getByText("Usage accounts")).toBeDefined(),
    );
    expect(usage.getAttribute("aria-expanded")).toBe("false");
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
});
