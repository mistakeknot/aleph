import {
  DIAGNOSTIC_ID_PATTERN,
  type BbDesktopDiagnosticEvent,
} from "@bb/desktop-contract";

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;

export type DiagnosticPayload = DistributiveOmit<
  BbDesktopDiagnosticEvent,
  "at"
>;
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

function matching(value: unknown, pattern: RegExp): string | null {
  return typeof value === "string" && pattern.test(value) ? value : null;
}

export function toDiagnosticId(value: unknown): string | null {
  return matching(value, DIAGNOSTIC_ID_PATTERN);
}
