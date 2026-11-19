// @vitest-environment jsdom

import { createStore } from "jotai";
import { atomWithStorage } from "jotai/utils";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createWindowScopedStorage } from "./browser-storage";

function storage() {
  return createWindowScopedStorage<boolean>({
    parse: (value, fallback) => (value === null ? fallback : value === "true"),
    serialize: String,
  });
}

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
});

afterEach(() => vi.restoreAllMocks());

it("migrates a legacy value once, then a fresh window uses its default", () => {
  window.localStorage.setItem("layout", "false");
  expect(storage().getItem("layout", true)).toBe(false);
  expect(window.sessionStorage.getItem("layout")).toBe("false");
  expect(window.localStorage.getItem("layout")).toBeNull();
  window.sessionStorage.clear();
  expect(storage().getItem("layout", true)).toBe(true);
});

it("keeps reload state without seeding another window from a toggle", () => {
  storage().setItem("layout", false);
  expect(storage().getItem("layout", true)).toBe(false);
  window.sessionStorage.clear();
  expect(storage().getItem("layout", true)).toBe(true);
});

it("ignores another window's storage events while mounted", () => {
  const layout = atomWithStorage("layout", true, storage(), {
    getOnInit: true,
  });
  const store = createStore();
  const unsubscribe = store.sub(layout, () => {});
  window.localStorage.setItem("layout", "false");
  window.dispatchEvent(
    new StorageEvent("storage", {
      key: "layout",
      newValue: "false",
      storageArea: window.localStorage,
    }),
  );
  expect(store.get(layout)).toBe(true);
  unsubscribe();
});

it("retains the legacy value when session storage cannot accept migration", () => {
  window.localStorage.setItem("layout", "false");
  vi.spyOn(window, "sessionStorage", "get").mockImplementation(() => {
    throw new DOMException("Blocked", "SecurityError");
  });
  expect(storage().getItem("layout", true)).toBe(true);
  expect(window.localStorage.getItem("layout")).toBe("false");
  expect(() => storage().setItem("layout", false)).not.toThrow();
});
