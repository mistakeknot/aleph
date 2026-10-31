import {
  WINDOW_REPORT_STALE_MS,
  type WindowPresetPane,
  type WindowPresetSuggestion,
  type WindowReport,
  type WindowSnapshot,
} from "@bb/domain";
import { readUiPreferences, writeUiPreference } from "./ui-preferences.js";
import type { AppDeps } from "../../types.js";

const MAX_TRACKED_WINDOWS = 64;
const MAX_WRITE_ATTEMPTS = 5;

const registries = new WeakMap<object, Map<string, WindowSnapshot>>();

function registryFor(deps: AppDeps): Map<string, WindowSnapshot> {
  const existing = registries.get(deps.db);
  if (existing) return existing;
  const created = new Map<string, WindowSnapshot>();
  registries.set(deps.db, created);
  return created;
}

function pruneStale(
  registry: Map<string, WindowSnapshot>,
  nowMs: number,
): void {
  for (const [id, snapshot] of registry) {
    if (nowMs - Date.parse(snapshot.reportedAt) > WINDOW_REPORT_STALE_MS) {
      registry.delete(id);
    }
  }
}

export function recordWindowReport(
  deps: AppDeps,
  report: WindowReport,
  now: Date = new Date(),
): WindowSnapshot {
  const registry = registryFor(deps);
  pruneStale(registry, now.getTime());
  const snapshot: WindowSnapshot = { ...report, reportedAt: now.toISOString() };
  registry.delete(report.windowId);
  registry.set(report.windowId, snapshot);
  while (registry.size > MAX_TRACKED_WINDOWS) {
    const oldest = registry.keys().next().value;
    if (oldest === undefined) break;
    registry.delete(oldest);
  }
  return snapshot;
}

export function listWindows(
  deps: AppDeps,
  now: Date = new Date(),
): WindowSnapshot[] {
  const registry = registryFor(deps);
  pruneStale(registry, now.getTime());
  return [...registry.values()].sort((a, b) =>
    a.windowId.localeCompare(b.windowId),
  );
}

export type ProposeOutcome =
  | { outcome: "proposed"; suggestion: WindowPresetSuggestion }
  | { outcome: "not_found" }
  | { outcome: "not_editable" }
  | { outcome: "conflict" };

export function proposeWindowPreset(
  deps: AppDeps,
  args: {
    presetId: string;
    panes: WindowPresetPane[];
    reason: string | null;
    proposedBy: string;
    now?: Date;
  },
): ProposeOutcome {
  const suggestion: WindowPresetSuggestion = {
    panes: args.panes,
    reason: args.reason,
    proposedBy: args.proposedBy,
    proposedAt: (args.now ?? new Date()).toISOString(),
  };
  for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt += 1) {
    const preferences = readUiPreferences(deps);
    const preset = preferences["windows.presets"].value.find(
      (candidate) => candidate.id === args.presetId,
    );
    if (!preset) return { outcome: "not_found" };
    if (!preset.userEditable) return { outcome: "not_editable" };
    const current = preferences["windows.suggestions"];
    const result = writeUiPreference(deps, {
      expectedRevision: current.revision,
      key: "windows.suggestions",
      value: { ...current.value, [args.presetId]: suggestion },
    });
    if (result.outcome === "updated") return { outcome: "proposed", suggestion };
  }
  return { outcome: "conflict" };
}
