import type { DbConnection } from "@bb/db";

const openFences = new WeakSet<DbConnection>();

export function isRelayFenceOpen(db: DbConnection): boolean {
  return openFences.has(db);
}

export function closeRelayFence(db: DbConnection): void {
  openFences.delete(db);
}

export function openRelayFence(db: DbConnection): void {
  openFences.add(db);
}
