// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createStore, Provider } from "jotai";
import { createElement, type ReactNode } from "react";
import { afterEach, expect, it } from "vitest";
import {
  resetFixedPanelTabsStateForTest,
  useFixedPanelTabsState,
  useOpenFixedSecondaryPanel,
  useCloseFixedSecondaryPanel,
  useSetFixedRightTerminalActiveTerminal,
} from "./fixed-panel-tabs";
import {
  createThreadInfoFixedPanelTab,
  getFixedPanelTabsStateStorageKey,
  serializeFixedPanelTabsState,
} from "./fixed-panel-tabs-state";

Object.defineProperty(window, "innerWidth", {
  configurable: true,
  value: 2200,
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  window.sessionStorage.clear();
  resetFixedPanelTabsStateForTest();
});

function setup() {
  const store = createStore();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(
      QueryClientProvider,
      { client },
      createElement(Provider, { store }, children),
    );
  return renderHook(
    () => ({
      state: useFixedPanelTabsState("same-thread", null),
      open: useOpenFixedSecondaryPanel("same-thread", null),
      close: useCloseFixedSecondaryPanel("same-thread", null),
      terminal: useSetFixedRightTerminalActiveTerminal("same-thread", null),
    }),
    { wrapper },
  );
}

it("keeps this window's visibility on reload and does not seed a later window from its toggle", () => {
  const first = setup();
  act(() => first.result.current.open());
  const tabs = first.result.current.state.secondary.tabs;
  const key = getFixedPanelTabsStateStorageKey({ threadId: "same-thread" });
  const firstVisibility = window.sessionStorage.getItem(key)!;
  expect(first.result.current.state.secondary.isOpen).toBe(true);
  first.unmount();
  resetFixedPanelTabsStateForTest();
  const reload = setup();
  expect(reload.result.current.state.secondary.isOpen).toBe(true);
  expect(reload.result.current.state.secondary.tabs).toEqual(tabs);
  reload.unmount();
  window.sessionStorage.clear();
  resetFixedPanelTabsStateForTest();
  const second = setup();
  expect(second.result.current.state.secondary.isOpen).toBe(false);
  expect(second.result.current.state.secondary.tabs).toEqual(tabs);
  act(() => second.result.current.open());
  act(() => second.result.current.terminal("shared-terminal"));
  act(() => second.result.current.close());
  expect(second.result.current.state.secondary.isOpen).toBe(false);
  second.unmount();
  window.sessionStorage.setItem(key, firstVisibility);
  resetFixedPanelTabsStateForTest();
  const firstAgain = setup();
  expect(firstAgain.result.current.state.secondary.isOpen).toBe(true);
  expect(
    firstAgain.result.current.state.secondary.tabs.some(
      (tab) => tab.kind === "terminal",
    ),
  ).toBe(true);
});

it("migrates legacy visibility once while retaining shared tab content", () => {
  const key = getFixedPanelTabsStateStorageKey({ threadId: "same-thread" });
  const tab = createThreadInfoFixedPanelTab();
  window.localStorage.setItem(
    key,
    serializeFixedPanelTabsState({
      state: {
        version: 1,
        lastUsedAt: Date.now(),
        secondary: { tabs: [tab], activeTabId: tab.id, isOpen: true },
      },
    }),
  );
  const first = setup();
  expect(first.result.current.state.secondary.isOpen).toBe(true);
  expect(first.result.current.state.secondary.tabs).toEqual([tab]);
  first.unmount();
  window.sessionStorage.clear();
  resetFixedPanelTabsStateForTest();
  const second = setup();
  expect(second.result.current.state.secondary.isOpen).toBe(false);
  expect(second.result.current.state.secondary.tabs).toEqual([tab]);
});

it("keeps a panel closed when its shared content no longer contains a tab", () => {
  const key = getFixedPanelTabsStateStorageKey({ threadId: "same-thread" });
  window.sessionStorage.setItem(
    key,
    JSON.stringify({ secondary: { isOpen: true } }),
  );
  const current = setup();
  expect(current.result.current.state.secondary.isOpen).toBe(false);
});
