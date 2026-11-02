// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createStore, Provider } from "jotai";
import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createThreadInfoFixedPanelTab,
  getFixedPanelTabsStateStorageKey,
} from "@/lib/fixed-panel-tabs-state";
import {
  resetFixedPanelTabsStateForTest,
  useCloseFixedSecondaryPanel,
  useFixedPanelTabsState,
  useOpenFixedSecondaryPanel,
  useSetFixedRightTerminalActiveTerminal,
  useSetFixedSecondaryPanelTab,
} from "@/lib/fixed-panel-tabs";
import { widthClassAtom } from "./layoutProfiles";

const THREAD = "thread-1";
const PANEL_KEY = getFixedPanelTabsStateStorageKey({ threadId: THREAD });
const SUPPRESSED_KEY = (cls: string) =>
  `aleph.layout.${cls}.secondaryPanelSuppressed`;

function seedOpenPanel(isOpen = true) {
  const tab = createThreadInfoFixedPanelTab();
  window.localStorage.setItem(
    PANEL_KEY,
    JSON.stringify({
      version: 1,
      lastUsedAt: Date.now(),
      secondary: { tabs: [tab], activeTabId: tab.id, isOpen },
    }),
  );
}

function setup() {
  const store = createStore();
  const queryClient = new QueryClient();
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(Provider, { store }, children),
    );
  const hook = renderHook(
    () => ({
      state: useFixedPanelTabsState(THREAD, null),
      close: useCloseFixedSecondaryPanel(THREAD, null),
      open: useOpenFixedSecondaryPanel(THREAD, null),
      setTab: useSetFixedSecondaryPanelTab(THREAD, null),
      setTerminal: useSetFixedRightTerminalActiveTerminal(THREAD, null),
    }),
    { wrapper },
  );
  const setWidth = (w: number) => act(() => store.set(widthClassAtom, w));
  const persistedOpen = () =>
    JSON.parse(window.localStorage.getItem(PANEL_KEY) ?? "{}").secondary
      ?.isOpen;
  // Mirrors panel.toggle: close when visible, otherwise open.
  const toggle = () =>
    act(() => {
      if (hook.result.current.state.secondary.isOpen) {
        hook.result.current.close();
      } else {
        hook.result.current.open();
      }
    });
  return { hook, setWidth, persistedOpen, toggle };
}

describe("width-class secondary panel suppression", () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetFixedPanelTabsStateForTest();
    seedOpenPanel();
  });
  afterEach(() => {
    cleanup();
    window.localStorage.clear();
  });

  it("hides an open panel in narrow and shows it in wide", () => {
    const { hook, setWidth } = setup();
    setWidth(1000);
    expect(hook.result.current.state.secondary.isOpen).toBe(false);
    setWidth(2200);
    expect(hook.result.current.state.secondary.isOpen).toBe(true);
  });

  it("toggle in narrow shows it and persists suppressed=false for narrow only", () => {
    const { hook, setWidth, toggle } = setup();
    setWidth(1000);
    toggle();
    expect(hook.result.current.state.secondary.isOpen).toBe(true);
    expect(window.localStorage.getItem(SUPPRESSED_KEY("narrow"))).toBe("false");
    expect(window.localStorage.getItem(SUPPRESSED_KEY("wide"))).toBeNull();
    expect(window.localStorage.getItem(SUPPRESSED_KEY("medium"))).toBeNull();
  });

  it("closing in narrow suppresses without touching per-thread state", () => {
    const { hook, setWidth, persistedOpen, toggle } = setup();
    setWidth(1000);
    toggle(); // show
    toggle(); // hide again
    expect(hook.result.current.state.secondary.isOpen).toBe(false);
    expect(window.localStorage.getItem(SUPPRESSED_KEY("narrow"))).toBe("true");
    expect(persistedOpen()).toBe(true);
    setWidth(2200);
    expect(hook.result.current.state.secondary.isOpen).toBe(true);
  });

  it("opening a tab in narrow clears suppression", () => {
    const { hook, setWidth } = setup();
    setWidth(1000);
    expect(hook.result.current.state.secondary.isOpen).toBe(false);
    act(() => hook.result.current.setTab("thread-info"));
    expect(hook.result.current.state.secondary.isOpen).toBe(true);
    expect(window.localStorage.getItem(SUPPRESSED_KEY("narrow"))).toBe("false");
  });

  it("wide behavior is unchanged: close writes per-thread state, no suppression", () => {
    const { hook, setWidth, persistedOpen } = setup();
    setWidth(2200);
    expect(hook.result.current.state.secondary.isOpen).toBe(true);
    act(() => hook.result.current.close());
    expect(persistedOpen()).toBe(false);
    expect(hook.result.current.state.secondary.isOpen).toBe(false);
    expect(window.localStorage.getItem(SUPPRESSED_KEY("wide"))).toBeNull();
  });

  describe("panel stored closed (single-action reveal)", () => {
    beforeEach(() => {
      window.localStorage.clear();
      resetFixedPanelTabsStateForTest();
      seedOpenPanel(false);
    });

    it("open / Cmd-J reveals in one action", () => {
      const { hook, setWidth, persistedOpen, toggle } = setup();
      setWidth(1000);
      toggle();
      expect(hook.result.current.state.secondary.isOpen).toBe(true);
      expect(persistedOpen()).toBe(true);
      expect(window.localStorage.getItem(SUPPRESSED_KEY("narrow"))).toBe(
        "false",
      );
    });

    it("set-tab reveals in one action", () => {
      const { hook, setWidth } = setup();
      setWidth(1000);
      act(() => hook.result.current.setTab("thread-info"));
      expect(hook.result.current.state.secondary.isOpen).toBe(true);
    });

    it("terminal open reveals in one action", () => {
      const { hook, setWidth } = setup();
      setWidth(1500);
      act(() => hook.result.current.setTerminal("term-1"));
      expect(hook.result.current.state.secondary.isOpen).toBe(true);
      expect(window.localStorage.getItem(SUPPRESSED_KEY("medium"))).toBe(
        "false",
      );
    });
  });
});
