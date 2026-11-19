// @vitest-environment jsdom

import { createStore } from "jotai";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: 2200,
  });
});

afterEach(() => vi.restoreAllMocks());

async function atoms() {
  vi.resetModules();
  const profiles = await import("./layoutProfiles");
  const { sidebarOpenAtom } =
    await import("@/components/layout/sidebar-open-atom");
  const panels =
    await import("@/components/secondary-panel/threadSecondaryPanelAtoms");
  const split = await import("@/lib/split-layout/atoms");
  const mobile = await import("@/views/mobile-recents-collapse");
  return {
    sidebar: sidebarOpenAtom,
    suppressed: profiles.secondaryPanelSuppressedAtom,
    collapsed: panels.getThreadConversationCollapsedAtom("window-test"),
    width: panels.secondaryPanelWidthPercentAtom,
    threadWidth: panels.getThreadSecondaryPanelWidthPercentAtom("window-test"),
    pluginWidth: panels.getPluginPageSecondaryPanelWidthPercentAtom({
      pluginId: "test",
      panelPath: "/test",
    }),
    maximized: split.maximizedPaneIdAtom,
    mobileCollapsed: mobile.mobileRecentsCollapsedThreadIdsAtom,
  };
}

it("isolates mounted layout atoms and restores only this window on reload", async () => {
  const first = await atoms();
  const store = createStore();
  const unsubscribers = Object.values(first).map((value) =>
    store.sub(value, () => {}),
  );
  store.set(first.sidebar, false);
  store.set(first.suppressed, true);
  store.set(first.collapsed, true);
  store.set(first.width, 37);
  store.set(first.threadWidth, 42);
  store.set(first.pluginWidth, 61);
  store.set(first.maximized, "pane-1");
  store.set(first.mobileCollapsed, ["window-test"]);
  const saved = Object.fromEntries(
    Object.keys(sessionStorage).map((key) => [
      key,
      sessionStorage.getItem(key)!,
    ]),
  );
  for (const [key, value] of Object.entries(saved)) {
    window.dispatchEvent(
      new StorageEvent("storage", {
        key,
        newValue: value === "true" ? "false" : "99",
        storageArea: window.localStorage,
      }),
    );
  }
  expect(store.get(first.sidebar)).toBe(false);
  expect(store.get(first.suppressed)).toBe(true);
  expect(store.get(first.collapsed)).toBe(true);
  expect(store.get(first.width)).toBe(42);
  expect(store.get(first.threadWidth)).toBe(42);
  expect(store.get(first.pluginWidth)).toBe(61);
  expect(store.get(first.maximized)).toBe("pane-1");
  expect(store.get(first.mobileCollapsed)).toEqual(["window-test"]);
  unsubscribers.forEach((unsubscribe) => unsubscribe());
  expect(window.localStorage.length).toBe(0);

  const reloaded = await atoms();
  const reloadStore = createStore();
  expect(reloadStore.get(reloaded.sidebar)).toBe(false);
  expect(reloadStore.get(reloaded.suppressed)).toBe(true);
  expect(reloadStore.get(reloaded.collapsed)).toBe(true);
  expect(reloadStore.get(reloaded.threadWidth)).toBe(42);
  expect(reloadStore.get(reloaded.pluginWidth)).toBe(61);
  expect(reloadStore.get(reloaded.maximized)).toBe("pane-1");
  expect(reloadStore.get(reloaded.mobileCollapsed)).toEqual(["window-test"]);

  window.sessionStorage.clear();
  const second = await atoms();
  const secondStore = createStore();
  expect(secondStore.get(second.sidebar)).toBe(true);
  expect(secondStore.get(second.suppressed)).toBe(false);
  expect(secondStore.get(second.collapsed)).toBe(false);
  expect(secondStore.get(second.width)).toBe(50);
  expect(secondStore.get(second.threadWidth)).toBe(50);
  expect(secondStore.get(second.pluginWidth)).toBe(50);
  expect(secondStore.get(second.maximized)).toBeNull();
  expect(secondStore.get(second.mobileCollapsed)).toEqual([]);
});

it("consumes the legacy sidebar value in one window only", async () => {
  window.localStorage.setItem("bb.sidebar.open", "false");
  const first = await atoms();
  expect(createStore().get(first.sidebar)).toBe(false);
  expect(window.localStorage.getItem("bb.sidebar.open")).toBeNull();
  window.sessionStorage.clear();
  const second = await atoms();
  expect(createStore().get(second.sidebar)).toBe(true);
});
