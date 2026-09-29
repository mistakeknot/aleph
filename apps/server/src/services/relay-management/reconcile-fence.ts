import type { DbConnection } from "@bb/db";

interface FenceState {
  observedGeneration: string | null | undefined;
  openGeneration: string | undefined;
}

const fences = new WeakMap<DbConnection, FenceState>();

function stateFor(db: DbConnection): FenceState {
  let state = fences.get(db);
  if (state === undefined) {
    state = { observedGeneration: undefined, openGeneration: undefined };
    fences.set(db, state);
  }
  return state;
}

export function isRelayFenceOpen(
  db: DbConnection,
  bindingGeneration: string,
): boolean {
  return fences.get(db)?.openGeneration === bindingGeneration;
}

export function closeRelayFence(db: DbConnection): void {
  stateFor(db).openGeneration = undefined;
}

export function openRelayFence(db: DbConnection, generation: string): void {
  const state = stateFor(db);
  state.openGeneration = generation;
  state.observedGeneration = generation;
}

export function observedRelayGeneration(
  db: DbConnection,
): string | null | undefined {
  return fences.get(db)?.observedGeneration;
}

export function observeRelayGeneration(
  db: DbConnection,
  generation: string | null | undefined,
): void {
  stateFor(db).observedGeneration = generation;
}
