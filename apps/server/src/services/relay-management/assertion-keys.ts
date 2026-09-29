import type { ConnectBindingRuntime } from "@bb/domain/relay-provenance";

export const RELAY_ASSERTION_MAX_KEY_LIFETIME_MS = 400 * 24 * 60 * 60 * 1000;
export const RELAY_ASSERTION_MAX_UNEXPIRED_KEYS_PER_RUNTIME = 2;

export const RELAY_ASSERTION_ISSUERS: Record<ConnectBindingRuntime, string> = {
  production: "https://getbb.app",
  staging: "https://vibecodethis.site",
};

export interface RelayAssertionKey {
  issuer: string;
  kid: string;
  notAfter: number;
  notBefore: number;
  publicKey: string;
  runtime: ConnectBindingRuntime;
}

export const RELAY_ASSERTION_KEYS: readonly RelayAssertionKey[] = [];

export function connectRuntimeForBaseUrl(
  baseUrl: string,
): ConnectBindingRuntime | null {
  let origin: string;
  try {
    origin = new URL(baseUrl).origin;
  } catch {
    return null;
  }
  for (const runtime of ["production", "staging"] as const) {
    if (origin === RELAY_ASSERTION_ISSUERS[runtime]) return runtime;
  }
  return null;
}

export function validateRelayAssertionKeyTable(
  keys: readonly RelayAssertionKey[],
  now: number,
): void {
  const kids = new Set<string>();
  const unexpired = new Map<ConnectBindingRuntime, number>();
  for (const key of keys) {
    if (kids.has(key.kid)) {
      throw new Error(`Duplicate relay assertion key id ${key.kid}`);
    }
    kids.add(key.kid);
    if (key.issuer !== RELAY_ASSERTION_ISSUERS[key.runtime]) {
      throw new Error(`Relay assertion key ${key.kid} has the wrong issuer`);
    }
    if (
      key.notAfter <= key.notBefore ||
      key.notAfter - key.notBefore > RELAY_ASSERTION_MAX_KEY_LIFETIME_MS
    ) {
      throw new Error(`Relay assertion key ${key.kid} has an invalid window`);
    }
    if (key.notAfter > now) {
      const count = (unexpired.get(key.runtime) ?? 0) + 1;
      unexpired.set(key.runtime, count);
      if (count > RELAY_ASSERTION_MAX_UNEXPIRED_KEYS_PER_RUNTIME) {
        throw new Error(
          `More than ${RELAY_ASSERTION_MAX_UNEXPIRED_KEYS_PER_RUNTIME} unexpired relay assertion keys for ${key.runtime}`,
        );
      }
    }
  }
}
