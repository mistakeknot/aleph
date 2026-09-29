import type { BbDesktopDiagnosticEvent } from "@bb/desktop-contract";

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;

export type DiagnosticPayload = DistributiveOmit<BbDesktopDiagnosticEvent, "at">;
type DiagnosticListener = (event: BbDesktopDiagnosticEvent) => void;

const listeners = new Set<DiagnosticListener>();

export function onDiagnostic(listener: DiagnosticListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function emitDiagnostic(build: () => DiagnosticPayload | null): void {
  if (listeners.size === 0) {
    return;
  }
  const payload = build();
  if (payload === null) {
    return;
  }
  const event: BbDesktopDiagnosticEvent = { ...payload, at: Date.now() };
  for (const listener of listeners) {
    listener(event);
  }
}

export function toDiagnosticToken(value: string | null | undefined): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  const token = value.replace(/[^A-Za-z0-9_.:-]+/g, "_").slice(0, 80);
  return token.length > 0 ? token : null;
}
