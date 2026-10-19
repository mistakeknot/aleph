import { desc, eq, notInArray } from "drizzle-orm";
import type { DbConnection } from "../connection.js";
import { alephInstallRequests } from "../schema.js";

export type StoredAlephInstallRequestState =
  | "requested"
  | "succeeded"
  | "expired"
  | "cancelled";

export interface StoredAlephInstallRequest {
  dismissed: boolean;
  manifestDigest: string;
  nonce: string;
  notifiedAt: number | null;
  requestedAt: number;
  state: StoredAlephInstallRequestState;
  target: string;
}

export type InsertAlephInstallRequestResult =
  | { outcome: "inserted" }
  | { outcome: "open-exists" }
  | { outcome: "nonce-exists" };

export function listStoredAlephInstallRequests(
  db: DbConnection,
): StoredAlephInstallRequest[] {
  return db
    .select()
    .from(alephInstallRequests)
    .orderBy(desc(alephInstallRequests.requestedAt))
    .all();
}

export function getStoredAlephInstallRequest(
  db: DbConnection,
  nonce: string,
): StoredAlephInstallRequest | undefined {
  return db
    .select()
    .from(alephInstallRequests)
    .where(eq(alephInstallRequests.nonce, nonce))
    .get();
}

export function insertStoredAlephInstallRequest(
  db: DbConnection,
  record: StoredAlephInstallRequest,
  keep: number,
): InsertAlephInstallRequestResult {
  return db.transaction((tx) => {
    const sameNonce = tx
      .select({ nonce: alephInstallRequests.nonce })
      .from(alephInstallRequests)
      .where(eq(alephInstallRequests.nonce, record.nonce))
      .get();
    if (sameNonce !== undefined) return { outcome: "nonce-exists" as const };
    const open = tx
      .select({ nonce: alephInstallRequests.nonce })
      .from(alephInstallRequests)
      .where(eq(alephInstallRequests.state, "requested"))
      .get();
    if (open !== undefined && record.state === "requested") {
      return { outcome: "open-exists" as const };
    }
    tx.insert(alephInstallRequests).values(record).run();
    const newest = tx
      .select({ nonce: alephInstallRequests.nonce })
      .from(alephInstallRequests)
      .orderBy(desc(alephInstallRequests.requestedAt))
      .limit(keep)
      .all()
      .map((row) => row.nonce);
    tx.delete(alephInstallRequests)
      .where(notInArray(alephInstallRequests.nonce, newest))
      .run();
    return { outcome: "inserted" as const };
  });
}

export function updateStoredAlephInstallRequest(
  db: DbConnection,
  nonce: string,
  patch: Partial<
    Pick<StoredAlephInstallRequest, "dismissed" | "notifiedAt" | "state">
  >,
): void {
  db.update(alephInstallRequests)
    .set(patch)
    .where(eq(alephInstallRequests.nonce, nonce))
    .run();
}
