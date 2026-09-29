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
  generation: string | null;
}

export type ConnectBindingReconcileResult =
  | { status: "missing" }
  | { status: "ok"; generation: string };

export class ConnectBindingConflictError extends Error {
  constructor() {
    super("connect binding changed under this process");
    this.name = "ConnectBindingConflictError";
  }
}

function assertExpectedGeneration(
  current: ConnectBindingRow | null,
  expectedGeneration: string | null | undefined,
): void {
  if (
    expectedGeneration !== undefined &&
    (current?.generation ?? null) !== expectedGeneration
  ) {
    throw new ConnectBindingConflictError();
  }
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
    left.reconciled === right.reconciled &&
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
  expectedGeneration?: string | null,
): ReplaceConnectBindingResult {
  return db.transaction(
    (tx: DbTransaction) => {
      const current = getConnectBinding(tx);
      assertExpectedGeneration(current, expectedGeneration);
      if (current === null) {
        return { cancellations: [], changed: false, generation: null };
      }
      const cancellations = cancelAllHostTargetsInTransaction(tx);
      tx.delete(connectBinding)
        .where(eq(connectBinding.id, CONNECT_BINDING_ROW_ID))
        .run();
      return { cancellations, changed: true, generation: null };
    },
    { behavior: "immediate" },
  );
}

export function replaceConnectBinding(
  db: DbConnection,
  input: ConnectBindingInput,
  now: number = Date.now(),
  expectedGeneration?: string | null,
): ReplaceConnectBindingResult {
  return db.transaction(
    (tx: DbTransaction) => {
      const current = getConnectBinding(tx);
      assertExpectedGeneration(current, expectedGeneration);
      if (current !== null && bindingsMatch(current, input)) {
        return {
          cancellations: [],
          changed: false,
          generation: current.generation,
        };
      }
      const generation = randomUUID();
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
          generation,
          reconciled: false,
        })
        .onConflictDoUpdate({
          target: connectBinding.id,
          set: {
            runtime: input.runtime,
            issuer: input.issuer,
            serverId: input.serverId,
            ownerUserId: input.ownerUserId,
            boundAt: now,
            generation,
            reconciled: false,
          },
        })
        .run();
      return { cancellations, changed: true, generation };
    },
    { behavior: "immediate" },
  );
}

export function setConnectBindingReconciled(
  db: DbConnection,
  reconciled: boolean,
  expectedGeneration?: string | null,
): ConnectBindingReconcileResult {
  return db.transaction(
    (tx: DbTransaction) => {
      const current = getConnectBinding(tx);
      assertExpectedGeneration(current, expectedGeneration);
      if (current === null) return { status: "missing" };
      if (current.reconciled === reconciled) {
        return { status: "ok", generation: current.generation };
      }
      const generation = randomUUID();
      tx.update(connectBinding)
        .set({ reconciled, generation })
        .where(eq(connectBinding.id, CONNECT_BINDING_ROW_ID))
        .run();
      return { status: "ok", generation };
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
