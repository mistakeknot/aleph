import { randomUUID } from "node:crypto";
import { eq, lte } from "drizzle-orm";
import type { ConnectBindingRuntime } from "@bb/domain/relay-provenance";
import type {
  DbConnection,
  DbQueryConnection,
  DbTransaction,
} from "../connection.js";
import { connectBinding, gateAssertionUses, hosts } from "../schema.js";
import {
  cancelRelayForHostTargetsInTransaction,
  type RelayCancellationResult,
} from "./relay.js";

export const CONNECT_BINDING_ROW_ID = 1;
export const CONNECT_REBIND_CANCEL_REASON = "connect_rebound";

export type ConnectBindingRow = typeof connectBinding.$inferSelect;

export interface ConnectBindingInput {
  issuer: string;
  ownerUserId: string;
  runtime: ConnectBindingRuntime;
  serverId: string;
}

export interface ReplaceConnectBindingResult {
  cancellations: RelayCancellationResult[];
  changed: boolean;
}

export function getConnectBinding(
  db: DbQueryConnection,
): ConnectBindingRow | null {
  return (
    db
      .select()
      .from(connectBinding)
      .where(eq(connectBinding.id, CONNECT_BINDING_ROW_ID))
      .get() ?? null
  );
}

export function connectBindingsEqual(
  left: ConnectBindingRow,
  right: ConnectBindingRow,
): boolean {
  return (
    left.generation === right.generation &&
    left.runtime === right.runtime &&
    left.issuer === right.issuer &&
    left.serverId === right.serverId &&
    left.ownerUserId === right.ownerUserId
  );
}

function bindingsMatch(
  current: ConnectBindingRow,
  next: ConnectBindingInput,
): boolean {
  return (
    current.runtime === next.runtime &&
    current.issuer === next.issuer &&
    current.serverId === next.serverId &&
    current.ownerUserId === next.ownerUserId
  );
}

function cancelAllHostTargetsInTransaction(
  tx: DbTransaction,
): RelayCancellationResult[] {
  return tx
    .select({ id: hosts.id })
    .from(hosts)
    .all()
    .map((host) =>
      cancelRelayForHostTargetsInTransaction(
        tx,
        host.id,
        CONNECT_REBIND_CANCEL_REASON,
      ),
    );
}

export function clearConnectBinding(
  db: DbConnection,
): ReplaceConnectBindingResult {
  return db.transaction(
    (tx: DbTransaction) => {
      if (getConnectBinding(tx) === null) {
        return { cancellations: [], changed: false };
      }
      const cancellations = cancelAllHostTargetsInTransaction(tx);
      tx.delete(connectBinding)
        .where(eq(connectBinding.id, CONNECT_BINDING_ROW_ID))
        .run();
      return { cancellations, changed: true };
    },
    { behavior: "immediate" },
  );
}

export function replaceConnectBinding(
  db: DbConnection,
  input: ConnectBindingInput,
  now: number = Date.now(),
): ReplaceConnectBindingResult {
  return db.transaction(
    (tx: DbTransaction) => {
      const current = getConnectBinding(tx);
      if (current !== null && bindingsMatch(current, input)) {
        return { cancellations: [], changed: false };
      }
      const cancellations =
        current === null ? [] : cancelAllHostTargetsInTransaction(tx);
      tx.insert(connectBinding)
        .values({
          id: CONNECT_BINDING_ROW_ID,
          runtime: input.runtime,
          issuer: input.issuer,
          serverId: input.serverId,
          ownerUserId: input.ownerUserId,
          boundAt: now,
          generation: randomUUID(),
        })
        .onConflictDoUpdate({
          target: connectBinding.id,
          set: {
            runtime: input.runtime,
            issuer: input.issuer,
            serverId: input.serverId,
            ownerUserId: input.ownerUserId,
            boundAt: now,
            generation: randomUUID(),
          },
        })
        .run();
      return { cancellations, changed: true };
    },
    { behavior: "immediate" },
  );
}

export function recordGateAssertionUse(
  db: DbQueryConnection,
  input: { expiresAt: number; jti: string },
): boolean {
  return (
    db
      .insert(gateAssertionUses)
      .values({ jti: input.jti, expiresAt: input.expiresAt })
      .onConflictDoNothing()
      .returning({ jti: gateAssertionUses.jti })
      .all().length === 1
  );
}

export function sweepExpiredGateAssertionUses(
  db: DbQueryConnection,
  now: number = Date.now(),
): number {
  return db
    .delete(gateAssertionUses)
    .where(lte(gateAssertionUses.expiresAt, now))
    .returning({ jti: gateAssertionUses.jti })
    .all().length;
}
