// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { createStore, Provider } from "jotai";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { booleanLocalStorage } from "@/lib/browser-storage";
import {
  classifyWidth,
  createClassScopedAtom,
  nextWidthClass,
  useWidthClassTracker,
  widthClassAtom,
  WIDTH_CLASS_DEBOUNCE_MS,
} from "./layoutProfiles";

function setWidth(width: number) {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    writable: true,
    value: width,
  });
}

function makeOpenAtom() {
  return createClassScopedAtom<boolean>({
    field: "sidebarOpen",
    storage: booleanLocalStorage,
    defaults: { narrow: false, medium: true, wide: true },
    legacyWideKey: "bb.sidebar.open",
  });
}

describe("width classes", () => {
  it("classifies at thresholds", () => {
    expect(classifyWidth(1279)).toBe("narrow");
    expect(classifyWidth(1280)).toBe("medium");
    expect(classifyWidth(1799)).toBe("medium");
    expect(classifyWidth(1800)).toBe("wide");
  });

  it("does not flap on jitter around a boundary", () => {
    let cls = nextWidthClass("medium", 1290);
    const seen = new Set<string>();
    for (const w of [1275, 1285, 1270, 1295, 1260, 1300, 1257]) {
      cls = nextWidthClass(cls, w);
      seen.add(cls);
    }
    expect(seen).toEqual(new Set(["medium"]));
    expect(nextWidthClass("medium", 1255)).toBe("narrow");
    expect(nextWidthClass("narrow", 1290)).toBe("narrow");
    expect(nextWidthClass("narrow", 1304)).toBe("medium");
    expect(nextWidthClass("wide", 1790)).toBe("wide");
    expect(nextWidthClass("wide", 1775)).toBe("medium");
    expect(nextWidthClass("narrow", 2400)).toBe("wide");
  });
});

describe("layout profiles", () => {
  beforeEach(() => {
    window.localStorage.clear();
    setWidth(2200);
  });
  afterEach(() => {
    vi.useRealTimers();
    window.localStorage.clear();
  });

  it("restores each profile on class change and never writes the class being left", () => {
    const openAtom = makeOpenAtom();
    const store = createStore();
    store.set(widthClassAtom, 2200);
    expect(store.get(openAtom)).toBe(true);
    store.set(openAtom, false); // wide: user closes sidebar
    store.set(widthClassAtom, 1500);
    expect(store.get(openAtom)).toBe(true); // medium default
    store.set(widthClassAtom, 1000);
    expect(store.get(openAtom)).toBe(false); // narrow default
    store.set(openAtom, true); // narrow: user opens
    expect(window.localStorage.getItem("aleph.layout.wide.sidebarOpen")).toBe(
      "false",
    );
    expect(window.localStorage.getItem("aleph.layout.narrow.sidebarOpen")).toBe(
      "true",
    );
    expect(window.localStorage.getItem("aleph.layout.medium.sidebarOpen")).toBe(
      null,
    );
    store.set(widthClassAtom, 2200);
    expect(store.get(openAtom)).toBe(false);
    store.set(widthClassAtom, 1000);
    expect(store.get(openAtom)).toBe(true);
  });

  it("a toggle in narrow never changes the wide profile", () => {
    const openAtom = makeOpenAtom();
    window.localStorage.setItem("aleph.layout.wide.sidebarOpen", "true");
    const store = createStore();
    store.set(widthClassAtom, 1000);
    store.set(openAtom, (prev) => !prev);
    store.set(openAtom, (prev) => !prev);
    expect(window.localStorage.getItem("aleph.layout.wide.sidebarOpen")).toBe(
      "true",
    );
    expect(window.localStorage.getItem("bb.sidebar.open")).toBeNull();
  });

  it("first run migrates the existing bb.* layout to wide", () => {
    window.localStorage.setItem("bb.sidebar.open", "false");
    const openAtom = makeOpenAtom();
    const store = createStore();
    store.set(widthClassAtom, 2200);
    expect(store.get(openAtom)).toBe(false);
    store.set(widthClassAtom, 1500);
    expect(store.get(openAtom)).toBe(true);
    // legacy key is left untouched
    expect(window.localStorage.getItem("bb.sidebar.open")).toBe("false");
  });

  it("tracker debounces resize and applies hysteresis", () => {
    vi.useFakeTimers();
    setWidth(1500);
    const store = createStore();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <Provider store={store}>{children}</Provider>
    );
    renderHook(() => useWidthClassTracker(), { wrapper });
    expect(store.get(widthClassAtom)).toBe("medium");
    const resize = (w: number) => {
      setWidth(w);
      act(() => {
        window.dispatchEvent(new Event("resize"));
      });
    };
    resize(1270);
    expect(store.get(widthClassAtom)).toBe("medium"); // debounced
    act(() => {
      vi.advanceTimersByTime(WIDTH_CLASS_DEBOUNCE_MS);
    });
    expect(store.get(widthClassAtom)).toBe("medium"); // inside hysteresis
    resize(1200);
    act(() => {
      vi.advanceTimersByTime(WIDTH_CLASS_DEBOUNCE_MS);
    });
    expect(store.get(widthClassAtom)).toBe("narrow");
  });
});
