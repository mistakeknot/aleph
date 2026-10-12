import { useEffect, useState } from "react";
import type { PluginRpcClient } from "@get-bb/plugin-sdk";
import { callPluginRpc } from "@/lib/plugin-sdk-hooks";
import type {
  PluginCommandPaletteSearchSlot,
  PluginNavPanelSlot,
} from "@/lib/plugin-slots";
import { getPluginPanelRoutePath } from "@/lib/route-paths";
import type { PaletteAction } from "./palette-action";

export const PLUGIN_SEARCH_ACTION_PREFIX = "plugin-search:";
export const PLUGIN_SEARCH_DEBOUNCE_MS = 150;
export const PLUGIN_SEARCH_TIMEOUT_MS = 3000;
export const PLUGIN_SEARCH_RESULT_LIMIT = 8;

interface NormalizedPluginSearchResult {
  id: string;
  title: string;
  detail: string | null;
  route: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

export function normalizePluginSearchResults(args: {
  slot: PluginCommandPaletteSearchSlot;
  panels: readonly PluginNavPanelSlot[];
  results: unknown;
}): NormalizedPluginSearchResult[] {
  if (!Array.isArray(args.results)) return [];
  const panelPaths = new Set(
    args.panels
      .filter((panel) => panel.pluginId === args.slot.pluginId)
      .map((panel) => panel.path),
  );
  const seen = new Set<string>();
  const normalized: NormalizedPluginSearchResult[] = [];
  for (const raw of args.results as unknown[]) {
    if (normalized.length >= PLUGIN_SEARCH_RESULT_LIMIT) break;
    if (!isRecord(raw) || !isRecord(raw.open)) continue;
    const id = nonEmptyString(raw.id);
    const title = nonEmptyString(raw.title);
    const panelPath = nonEmptyString(raw.open.panelPath);
    if (id === null || title === null || panelPath === null) continue;
    if (!panelPaths.has(panelPath) || seen.has(id)) continue;
    const subPath = raw.open.subPath;
    if (subPath !== undefined && typeof subPath !== "string") continue;
    seen.add(id);
    normalized.push({
      id,
      title,
      detail: nonEmptyString(raw.detail),
      route: getPluginPanelRoutePath({
        pluginId: args.slot.pluginId,
        path: panelPath,
        ...(subPath === undefined ? {} : { subPath }),
      }),
    });
  }
  return normalized;
}

export function buildPluginSearchPaletteActions(args: {
  slot: PluginCommandPaletteSearchSlot;
  results: readonly NormalizedPluginSearchResult[];
  navigate: (path: string) => void;
}): PaletteAction[] {
  return args.results.map((result) => ({
    id: `${PLUGIN_SEARCH_ACTION_PREFIX}${args.slot.pluginId}/${args.slot.id}/${result.id}`,
    bucket: "Plugins" as const,
    group:
      result.detail === null
        ? args.slot.title
        : `${args.slot.title} · ${result.detail}`,
    title: result.title,
    shortcut: null,
    run: () => args.navigate(result.route),
  }));
}

export function isPluginSearchQuery(query: string): boolean {
  return query.trim() !== "" && !query.startsWith(">");
}

function pluginRpcClient(
  pluginId: string,
  signal: AbortSignal,
): PluginRpcClient {
  return {
    call: (method: string, input?: unknown) =>
      callPluginRpc(fetch, pluginId, method, input, signal),
  } as PluginRpcClient;
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("aborted");
}

export async function runPluginSearchProvider(args: {
  slot: PluginCommandPaletteSearchSlot;
  panels: readonly PluginNavPanelSlot[];
  query: string;
  projectId: string | null;
  signal: AbortSignal;
  navigate: (path: string) => void;
}): Promise<PaletteAction[]> {
  if (args.signal.aborted) return [];
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(abortReason(args.signal));
  args.signal.addEventListener("abort", forwardAbort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const results = await Promise.race([
      Promise.resolve().then(() =>
        args.slot.search(args.query.trim(), {
          rpc: pluginRpcClient(args.slot.pluginId, controller.signal),
          projectId: args.projectId,
          signal: controller.signal,
        }),
      ),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          const error = new Error(
            `timed out after ${PLUGIN_SEARCH_TIMEOUT_MS}ms`,
          );
          controller.abort(error);
          reject(error);
        }, PLUGIN_SEARCH_TIMEOUT_MS);
        controller.signal.addEventListener(
          "abort",
          () => reject(abortReason(controller.signal)),
          { once: true },
        );
      }),
    ]);
    return buildPluginSearchPaletteActions({
      slot: args.slot,
      results: normalizePluginSearchResults({
        slot: args.slot,
        panels: args.panels,
        results,
      }),
      navigate: args.navigate,
    });
  } catch (error) {
    if (!args.signal.aborted) {
      console.warn(
        `[plugin ${args.slot.pluginId}] command palette search "${args.slot.id}" failed`,
        error,
      );
    }
    return [];
  } finally {
    clearTimeout(timer);
    args.signal.removeEventListener("abort", forwardAbort);
    if (!controller.signal.aborted) controller.abort(new Error("settled"));
  }
}

export interface PluginPaletteSearchState {
  actions: readonly PaletteAction[];
  pending: boolean;
}

const IDLE_STATE: PluginPaletteSearchState = { actions: [], pending: false };

interface SettledSearch {
  query: string;
  projectId: string | null;
  slots: readonly PluginCommandPaletteSearchSlot[];
  panels: readonly PluginNavPanelSlot[];
  actions: readonly PaletteAction[];
}

export function usePluginPaletteSearch(args: {
  enabled: boolean;
  query: string;
  slots: readonly PluginCommandPaletteSearchSlot[];
  panels: readonly PluginNavPanelSlot[];
  projectId: string | null;
  navigate: (path: string) => void;
}): PluginPaletteSearchState {
  const { enabled, query, slots, panels, projectId, navigate } = args;
  const active = enabled && slots.length > 0 && isPluginSearchQuery(query);
  const [settled, setSettled] = useState<SettledSearch | null>(null);

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void Promise.all(
        slots.map((slot) =>
          runPluginSearchProvider({
            slot,
            panels,
            query,
            projectId,
            signal: controller.signal,
            navigate,
          }),
        ),
      ).then((groups) => {
        if (controller.signal.aborted) return;
        setSettled({ query, projectId, slots, panels, actions: groups.flat() });
      });
    }, PLUGIN_SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort(new Error("superseded"));
    };
  }, [active, navigate, panels, projectId, query, slots]);

  if (!active) return IDLE_STATE;
  if (
    settled === null ||
    settled.query !== query ||
    settled.projectId !== projectId ||
    settled.slots !== slots ||
    settled.panels !== panels
  ) {
    return { actions: [], pending: true };
  }
  return { actions: settled.actions, pending: false };
}
