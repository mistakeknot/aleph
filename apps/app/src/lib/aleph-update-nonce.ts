import type { SystemAlephUpdateRun } from "@bb/server-contract";

export type AlephUpdateOperation = "update" | "rollback" | "recover";

export interface AlephPendingRequest {
  nonce: string;
  operation: AlephUpdateOperation;
  body: Record<string, unknown>;
  sentAt: number;
  resent: boolean;
}

export interface AlephNonceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export type AlephPendingAction =
  | "wait"
  | "resend"
  | "resolved"
  | "outcome-unknown";

export const ALEPH_NONCE_RESEND_MS = 60 * 1000;
export const ALEPH_NONCE_UNKNOWN_MS = 55 * 60 * 1000;

const STORAGE_KEY = "aleph-update-pending";

const TERMINAL_STATES: ReadonlySet<SystemAlephUpdateRun["state"]> = new Set([
  "succeeded",
  "aborted",
  "rolled-back",
  "recovery-incomplete",
  "refused",
  "unknown",
]);

export function generateAlephNonce(
  fill: (bytes: Uint8Array<ArrayBuffer>) => Uint8Array = (bytes) =>
    crypto.getRandomValues(bytes),
): string {
  const bytes = fill(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

export function alephOutcomeUnknownMessage(nonce: string): string {
  return `Outcome unknown: run \`aleph-update status ${nonce}\` (root shell)`;
}

function parsePending(raw: string | null): AlephPendingRequest | null {
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return null;
    const record = value as Record<string, unknown>;
    const { nonce, operation, body, sentAt, resent } = record;
    if (
      typeof nonce !== "string" ||
      !/^[0-9a-f]{32}$/u.test(nonce) ||
      (operation !== "update" &&
        operation !== "rollback" &&
        operation !== "recover") ||
      typeof body !== "object" ||
      body === null ||
      typeof sentAt !== "number" ||
      typeof resent !== "boolean"
    ) {
      return null;
    }
    return {
      nonce,
      operation,
      body: body as Record<string, unknown>,
      sentAt,
      resent,
    };
  } catch {
    return null;
  }
}

export function createAlephNonceStore(
  storage: AlephNonceStorage,
  now: () => number = Date.now,
) {
  const read = () => parsePending(storage.getItem(STORAGE_KEY));
  const write = (pending: AlephPendingRequest) =>
    storage.setItem(STORAGE_KEY, JSON.stringify(pending));
  return {
    read,
    begin(
      operation: AlephUpdateOperation,
      body: Record<string, unknown>,
    ): AlephPendingRequest {
      const existing = read();
      if (existing !== null) return existing;
      const pending: AlephPendingRequest = {
        nonce: generateAlephNonce(),
        operation,
        body: { ...body },
        sentAt: now(),
        resent: false,
      };
      write(pending);
      return pending;
    },
    markResent() {
      const existing = read();
      if (existing !== null) write({ ...existing, resent: true });
    },
    resolve() {
      storage.removeItem(STORAGE_KEY);
    },
  };
}

export function evaluateAlephPending(
  pending: AlephPendingRequest,
  state: SystemAlephUpdateRun["state"],
  now: number,
): AlephPendingAction {
  if (TERMINAL_STATES.has(state)) return "resolved";
  const elapsed = now - pending.sentAt;
  if (elapsed >= ALEPH_NONCE_UNKNOWN_MS) return "outcome-unknown";
  if (
    state === "not-found" &&
    !pending.resent &&
    elapsed >= ALEPH_NONCE_RESEND_MS
  ) {
    return "resend";
  }
  return "wait";
}
