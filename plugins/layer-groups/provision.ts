import type { Layer, LayerSnapshot } from "./registry";
import type { LayerGroupsStore, LayerSectionRow } from "./store";

export interface SectionsPort {
  list(): Promise<Array<{ id: string; name: string }>>;
  create(name: string): Promise<{ id: string; name: string }>;
  hasThreads(sectionId: string): Promise<boolean>;
}

export function sectionNameFor(layer: Layer): string {
  return `${layer.letter} · ${layer.name.split(" / ")[0].trim()}`;
}

export type ProvisionAction =
  | { kind: "keep"; layer: string; sectionId: string; label: string }
  | { kind: "create"; layer: string; name: string }
  | {
      kind: "needs-adopt";
      layer: string;
      sectionId: string;
      name: string;
      hasThreads: boolean;
    }
  | {
      kind: "disable";
      layer: string;
      sectionId: string;
      reason: "section-deleted";
    }
  | { kind: "skip-disabled"; layer: string }
  | { kind: "adopt-pending"; layer: string; sectionId: string };

export interface ProvisionReport {
  mode: "preview" | "apply";
  applied: boolean;
  actions: ProvisionAction[];
  errors: string[];
}

export async function planProvision(args: {
  snapshot: LayerSnapshot;
  rows: LayerSectionRow[];
  port: SectionsPort;
}): Promise<ProvisionAction[]> {
  const sections = await args.port.list();
  const sectionsById = new Map(
    sections.map((section) => [section.id, section]),
  );
  const sectionsByName = new Map(
    sections.map((section) => [section.name, section]),
  );
  const rowsByLayer = new Map(args.rows.map((row) => [row.layer, row]));
  const actions: ProvisionAction[] = [];
  for (const layer of args.snapshot.layers) {
    const row = rowsByLayer.get(layer.key);
    if (row?.state === "disabled") {
      actions.push({ kind: "skip-disabled", layer: layer.key });
    } else if (row?.state === "adopting") {
      actions.push({
        kind: "adopt-pending",
        layer: layer.key,
        sectionId: row.sectionId,
      });
    } else if (row) {
      const section = sectionsById.get(row.sectionId);
      actions.push(
        section
          ? {
              kind: "keep",
              layer: layer.key,
              sectionId: row.sectionId,
              label: section.name,
            }
          : {
              kind: "disable",
              layer: layer.key,
              sectionId: row.sectionId,
              reason: "section-deleted",
            },
      );
    } else {
      const name = sectionNameFor(layer);
      const section = sectionsByName.get(name);
      actions.push(
        section
          ? {
              kind: "needs-adopt",
              layer: layer.key,
              sectionId: section.id,
              name,
              hasThreads: await args.port.hasThreads(section.id),
            }
          : { kind: "create", layer: layer.key, name },
      );
    }
  }
  return actions;
}

export async function applyProvision(args: {
  mode: "preview" | "apply";
  actions: ProvisionAction[];
  store: LayerGroupsStore;
  port: SectionsPort;
  now: number;
  signal?: { aborted: boolean };
}): Promise<ProvisionReport> {
  const { mode, actions, store, port, now, signal } = args;
  const report: ProvisionReport = { mode, applied: false, actions, errors: [] };
  const record = () =>
    store.recordRun({ kind: "provision", mode, at: now, report });
  if (
    mode === "preview" ||
    actions.some((action) => action.kind === "needs-adopt")
  ) {
    record();
    return report;
  }
  const created: LayerSectionRow[] = [];
  const disabled: Array<Extract<ProvisionAction, { kind: "disable" }>> = [];
  for (const action of actions) {
    if (signal?.aborted) break;
    if (action.kind === "create") {
      try {
        const section = await port.create(action.name);
        created.push({
          layer: action.layer,
          sectionId: section.id,
          state: "active",
          createdName: section.name,
          disabledReason: null,
          updatedAt: now,
        });
        if (signal?.aborted) break;
      } catch (cause) {
        report.errors.push(
          cause instanceof Error ? cause.message : String(cause),
        );
        break;
      }
    } else if (action.kind === "disable") {
      disabled.push(action);
    }
  }
  report.applied = !signal?.aborted && report.errors.length === 0;
  store.transaction(() => {
    for (const row of created) store.upsertLayerSection(row);
    for (const action of disabled)
      store.setLayerState(action.layer, "disabled", action.reason, now);
    record();
  });
  return report;
}

export type AdoptResult =
  | { kind: "adopted"; layer: string; sectionId: string }
  | {
      kind: "conflict";
      layer: string;
      sectionId: string;
      reason: "not-empty" | "renamed" | "gone";
    }
  | { kind: "not-found"; layer: string }
  | { kind: "already-owned"; layer: string };

async function verifyAdoption(
  row: LayerSectionRow,
  port: SectionsPort,
): Promise<"not-empty" | "renamed" | "gone" | null> {
  const section = (await port.list()).find(
    (section) => section.id === row.sectionId,
  );
  if (!section) return "gone";
  if (section.name !== row.createdName) return "renamed";
  return (await port.hasThreads(row.sectionId)) ? "not-empty" : null;
}

export async function adoptSection(args: {
  layer: Layer;
  store: LayerGroupsStore;
  port: SectionsPort;
  now: number;
}): Promise<AdoptResult> {
  const { layer, store, port, now } = args;
  if (store.layerSections().some((row) => row.layer === layer.key))
    return { kind: "already-owned", layer: layer.key };
  const name = sectionNameFor(layer);
  const section = (await port.list()).find((section) => section.name === name);
  if (!section) return { kind: "not-found", layer: layer.key };
  if (await port.hasThreads(section.id))
    return {
      kind: "conflict",
      layer: layer.key,
      sectionId: section.id,
      reason: "not-empty",
    };
  const row: LayerSectionRow = {
    layer: layer.key,
    sectionId: section.id,
    state: "adopting",
    createdName: name,
    disabledReason: null,
    updatedAt: now,
  };
  const committed = store.transaction(() => {
    if (store.layerSections().some((row) => row.layer === layer.key))
      return false;
    store.upsertLayerSection(row);
    return true;
  });
  if (!committed) return { kind: "already-owned", layer: layer.key };
  const reason = await verifyAdoption(row, port);
  store.transaction(() => {
    if (reason) store.removeLayerSection(layer.key);
    else store.setLayerState(layer.key, "active", null, now);
  });
  return reason
    ? { kind: "conflict", layer: layer.key, sectionId: section.id, reason }
    : { kind: "adopted", layer: layer.key, sectionId: section.id };
}

export async function recoverAdoptions(args: {
  store: LayerGroupsStore;
  port: SectionsPort;
  now: number;
}): Promise<
  Array<{
    layer: string;
    outcome: "promoted" | "removed";
    reason?: "not-empty" | "renamed" | "gone";
  }>
> {
  const results: Awaited<ReturnType<typeof recoverAdoptions>> = [];
  for (const row of args.store.layerSections()) {
    if (row.state !== "adopting") continue;
    const reason = await verifyAdoption(row, args.port);
    args.store.transaction(() => {
      if (reason) args.store.removeLayerSection(row.layer);
      else args.store.setLayerState(row.layer, "active", null, args.now);
    });
    results.push(
      reason
        ? { layer: row.layer, outcome: "removed", reason }
        : { layer: row.layer, outcome: "promoted" },
    );
  }
  return results;
}
