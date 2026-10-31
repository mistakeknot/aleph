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
  const baseTime = (args.now ?? new Date()).getTime();
  for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt += 1) {
    const preferences = readUiPreferences(deps);
    const preset = preferences["windows.presets"].value.find(
      (candidate) => candidate.id === args.presetId,
    );
    if (!preset) return { outcome: "not_found" };
    if (!preset.userEditable) return { outcome: "not_editable" };
    const current = preferences["windows.suggestions"];
    // proposedAt is the suggestion's identity for accept and dismiss, so a
    // replacement must never reuse the previous one's value.
    const previous = current.value[args.presetId]?.proposedAt;
    // Strictly later than the previous one, so identities never repeat.
    const previousMs = previous ? Date.parse(previous) : Number.NaN;
    const at = Number.isFinite(previousMs)
      ? Math.max(baseTime, previousMs + 1)
      : baseTime;
    const suggestion: WindowPresetSuggestion = {
      panes: args.panes,
      reason: args.reason,
      proposedBy: args.proposedBy,
      proposedAt: new Date(at).toISOString(),
    };
    const result = writeUiPreference(deps, {
      expectedRevision: current.revision,
      key: "windows.suggestions",
      value: { ...current.value, [args.presetId]: suggestion },
    });
    if (result.outcome === "updated")
      return { outcome: "proposed", suggestion };
  }
  return { outcome: "conflict" };
}

export type AcceptOutcome =
  | { outcome: "accepted"; panes: WindowPresetPane[] }
  | { outcome: "not_found" }
  | { outcome: "no_suggestion" }
  | { outcome: "unknown_window" }
  | { outcome: "stale" }
  | { outcome: "conflict" };

export function acceptWindowSuggestion(
  deps: AppDeps,
  args: {
    presetId: string;
    windowId: string;
    proposedAt: string;
    now?: Date;
  },
): AcceptOutcome {
  const registry = registryFor(deps);
  pruneStale(registry, (args.now ?? new Date()).getTime());
  if (registry.get(args.windowId)?.presetId !== args.presetId) {
    return { outcome: "unknown_window" };
  }
  for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt += 1) {
    const preferences = readUiPreferences(deps);
    const presets = preferences["windows.presets"];
    const preset = presets.value.find(
      (candidate) => candidate.id === args.presetId,
    );
    if (!preset || !preset.userEditable) return { outcome: "not_found" };
    const suggestions = preferences["windows.suggestions"];
    const suggestion = suggestions.value[args.presetId];
    if (!suggestion) return { outcome: "no_suggestion" };
    if (suggestion.proposedAt !== args.proposedAt) return { outcome: "stale" };
    const written = writeUiPreference(deps, {
      expectedRevision: presets.revision,
      key: "windows.presets",
      value: presets.value.map((candidate) =>
        candidate.id === args.presetId
          ? { ...candidate, panes: suggestion.panes }
          : candidate,
      ),
    });
    if (written.outcome !== "updated") continue;
    const { [args.presetId]: _accepted, ...remaining } = suggestions.value;
    writeUiPreference(deps, {
      expectedRevision: suggestions.revision,
      key: "windows.suggestions",
      value: remaining,
    });
    return { outcome: "accepted", panes: suggestion.panes };
  }
  return { outcome: "conflict" };
}

export function dismissWindowSuggestion(
  deps: AppDeps,
  presetId: string,
  proposedAt: string,
): { outcome: "dismissed" } | { outcome: "stale" } | { outcome: "conflict" } {
  for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt += 1) {
    const suggestions = readUiPreferences(deps)["windows.suggestions"];
    const current = suggestions.value[presetId];
    if (!current) return { outcome: "dismissed" };
    if (current.proposedAt !== proposedAt) return { outcome: "stale" };
    const { [presetId]: _removed, ...remaining } = suggestions.value;
    const written = writeUiPreference(deps, {
      expectedRevision: suggestions.revision,
      key: "windows.suggestions",
      value: remaining,
    });
    if (written.outcome === "updated") return { outcome: "dismissed" };
  }
  return { outcome: "conflict" };
}
