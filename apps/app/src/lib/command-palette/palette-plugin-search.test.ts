// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  PluginCommandPaletteSearchSlot,
  PluginNavPanelSlot,
} from "@/lib/plugin-slots";
import {
  buildPluginSearchPaletteActions,
  normalizePluginSearchResults,
  PLUGIN_SEARCH_DEBOUNCE_MS,
  PLUGIN_SEARCH_RESULT_LIMIT,
  PLUGIN_SEARCH_TIMEOUT_MS,
  runPluginSearchProvider,
  usePluginPaletteSearch,
} from "./palette-plugin-search";

function searchSlot(
  search: PluginCommandPaletteSearchSlot["search"],
  overrides: Partial<PluginCommandPaletteSearchSlot> = {},
): PluginCommandPaletteSearchSlot {
  return {
    id: "tasks",
    title: "Tasks",
    search,
    pluginId: "tasks",
    generation: 1,
    ...overrides,
  };
}

function navPanel(pluginId: string, path: string): PluginNavPanelSlot {
  return {
    id: path,
    title: path,
    icon: "List",
    path,
    component: () => null,
    pluginId,
    generation: 1,
  } as PluginNavPanelSlot;
}

const panels = [navPanel("tasks", "tasks"), navPanel("other", "elsewhere")];
const emptySearch = async () => [];

function row(id: string, open: unknown = { panelPath: "tasks" }) {
  return { id, title: `Title ${id}`, open };
}

function result(id: string) {
  return { id, title: `Title ${id}`, open: { panelPath: "tasks" } };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("normalizePluginSearchResults", () => {
  it("keeps well-formed rows and builds the plugin panel route", () => {
    expect(
      normalizePluginSearchResults({
        slot: searchSlot(emptySearch),
        panels,
        results: [
          {
            id: "a",
            title: "AUTA-316 Fix",
            detail: "Todo",
            open: { panelPath: "tasks", subPath: "task/AUTA-316" },
          },
          { id: "b", title: "Plain", open: { panelPath: "tasks" } },
        ],
      }),
    ).toEqual([
      {
        id: "a",
        title: "AUTA-316 Fix",
        detail: "Todo",
        route: "/plugins/tasks/tasks/task/AUTA-316",
      },
      { id: "b", title: "Plain", detail: null, route: "/plugins/tasks/tasks" },
    ]);
  });

  it("drops malformed rows and destinations the plugin does not own", () => {
    expect(
      normalizePluginSearchResults({
        slot: searchSlot(emptySearch),
        panels,
        results: [
          null,
          "row",
          { id: "no-open", title: "x" },
          { id: " ", title: "blank id", open: { panelPath: "tasks" } },
          { id: "blank-title", title: "", open: { panelPath: "tasks" } },
          { id: 7, title: "numeric id", open: { panelPath: "tasks" } },
          row("unknown-panel", { panelPath: "missing" }),
          row("other-plugin", { panelPath: "elsewhere" }),
          row("numeric-sub", { panelPath: "tasks", subPath: 42 }),
          row("kept"),
          row("kept"),
        ],
      }).map((result) => result.id),
    ).toEqual(["kept"]);
    expect(
      normalizePluginSearchResults({
        slot: searchSlot(emptySearch),
        panels,
        results: { id: "not-an-array" },
      }),
    ).toEqual([]);
  });

  it("caps results per provider", () => {
    const results = Array.from({ length: 20 }, (_, index) => row(`r${index}`));
    expect(
      normalizePluginSearchResults({
        slot: searchSlot(emptySearch),
        panels,
        results,
      }),
    ).toHaveLength(PLUGIN_SEARCH_RESULT_LIMIT);
  });
});

describe("buildPluginSearchPaletteActions", () => {
  it("namespaces ids and navigates to the result route", () => {
    const navigate = vi.fn();
    const [action] = buildPluginSearchPaletteActions({
      slot: searchSlot(emptySearch),
      results: [
        { id: "a", title: "A", detail: "Done", route: "/plugins/tasks/tasks" },
      ],
      navigate,
    });
    expect(action).toMatchObject({
      id: "plugin-search:tasks/tasks/a",
      bucket: "Plugins",
      group: "Tasks · Done",
      title: "A",
    });
    action?.run();
    expect(navigate).toHaveBeenCalledWith("/plugins/tasks/tasks");
  });
});

describe("runPluginSearchProvider", () => {
  it("binds the provider's signal to its RPC transport and aborts it once settled", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: [] }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    let providerSignal: AbortSignal | undefined;
    const actions = await runPluginSearchProvider({
      slot: searchSlot(async (_query, context) => {
        providerSignal = context.signal;
        await context.rpc.call("listTasks", { search: "x" });
        return [result("a")];
      }),
      panels,
      query: "  x  ",
      projectId: null,
      signal: new AbortController().signal,
      navigate: () => {},
    });
    expect(actions.map((action) => action.title)).toEqual(["Title a"]);
    const init = (
      fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    )[1];
    expect(init.signal).toBe(providerSignal);
    expect(providerSignal?.aborted).toBe(true);
  });

  it("times out one provider without waiting for it and aborts its signal", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let providerSignal: AbortSignal | undefined;
    const pending = runPluginSearchProvider({
      slot: searchSlot((_query, context) => {
        providerSignal = context.signal;
        return new Promise(() => {});
      }),
      panels,
      query: "x",
      projectId: null,
      signal: new AbortController().signal,
      navigate: () => {},
    });
    await vi.advanceTimersByTimeAsync(PLUGIN_SEARCH_TIMEOUT_MS);
    await expect(pending).resolves.toEqual([]);
    expect(providerSignal?.aborted).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("contains a synchronous throw and a rejection", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const base = {
      panels,
      query: "x",
      projectId: null,
      signal: new AbortController().signal,
      navigate: () => {},
    };
    await expect(
      runPluginSearchProvider({
        ...base,
        slot: searchSlot(() => {
          throw new Error("sync");
        }),
      }),
    ).resolves.toEqual([]);
    await expect(
      runPluginSearchProvider({
        ...base,
        slot: searchSlot(async () => {
          throw new Error("async");
        }),
      }),
    ).resolves.toEqual([]);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("forwards a query cancellation to the provider without warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const controller = new AbortController();
    let providerSignal: AbortSignal | undefined;
    const pending = runPluginSearchProvider({
      slot: searchSlot((_query, context) => {
        providerSignal = context.signal;
        return new Promise(() => {});
      }),
      panels,
      query: "x",
      projectId: null,
      signal: controller.signal,
      navigate: () => {},
    });
    await Promise.resolve();
    controller.abort();
    await expect(pending).resolves.toEqual([]);
    expect(providerSignal?.aborted).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("usePluginPaletteSearch", () => {
  function renderSearch(
    slots: readonly PluginCommandPaletteSearchSlot[],
    query: string,
  ) {
    const navigate = () => {};
    return renderHook(
      (props: { query: string; enabled: boolean }) =>
        usePluginPaletteSearch({
          enabled: props.enabled,
          query: props.query,
          slots,
          panels,
          projectId: null,
          navigate,
        }),
      { initialProps: { query, enabled: true } },
    );
  }

  it("debounces, ignores a superseded query, and skips command mode", async () => {
    vi.useFakeTimers();
    const queries: string[] = [];
    const resolvers = new Map<string, (rows: unknown[]) => void>();
    const slots = [
      searchSlot(
        (query) =>
          new Promise((resolve) => {
            queries.push(query);
            resolvers.set(query, resolve as (rows: unknown[]) => void);
          }),
      ),
    ];
    const hook = renderSearch(slots, "au");
    expect(hook.result.current.pending).toBe(true);
    hook.rerender({ query: "auta", enabled: true });
    await act(() => vi.advanceTimersByTimeAsync(PLUGIN_SEARCH_DEBOUNCE_MS));
    expect(queries).toEqual(["auta"]);

    hook.rerender({ query: "auta-3", enabled: true });
    await act(() => vi.advanceTimersByTimeAsync(PLUGIN_SEARCH_DEBOUNCE_MS));
    await act(async () => resolvers.get("auta")?.([row("stale")]));
    expect(hook.result.current).toEqual({ actions: [], pending: true });

    await act(async () => resolvers.get("auta-3")?.([row("fresh")]));
    expect(hook.result.current.pending).toBe(false);
    expect(hook.result.current.actions.map((action) => action.title)).toEqual([
      "Title fresh",
    ]);

    hook.rerender({ query: ">auta", enabled: true });
    await act(() => vi.advanceTimersByTimeAsync(PLUGIN_SEARCH_DEBOUNCE_MS));
    expect(hook.result.current).toEqual({ actions: [], pending: false });
    hook.rerender({ query: "auta-3", enabled: false });
    expect(hook.result.current).toEqual({ actions: [], pending: false });
    expect(queries).toEqual(["auta", "auta-3"]);
  });

  it("settles with the providers that answered when another fails", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const hook = renderSearch(
      [
        searchSlot(async () => {
          throw new Error("boom");
        }),
        searchSlot(async () => [result("ok")], { id: "second" }),
      ],
      "query",
    );
    await act(() => vi.advanceTimersByTimeAsync(PLUGIN_SEARCH_DEBOUNCE_MS));
    expect(hook.result.current.pending).toBe(false);
    expect(hook.result.current.actions.map((action) => action.id)).toEqual([
      "plugin-search:tasks/second/ok",
    ]);
  });
});
