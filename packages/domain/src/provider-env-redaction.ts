/**
 * Redaction for `provider.env-resolved` event payloads.
 *
 * The event records the environment a provider session was launched with so
 * operators can debug resolution. That environment carries credentials (the
 * Account Pooler bearer token among them), and the event is served by every
 * thread read path (`bb thread log --json`, the public events API, timeline,
 * export). The rule is applied when the event is recorded and again when a
 * stored row is decoded, because rows written before the record-time fix still
 * hold the plaintext values.
 *
 * The sanitizer is pure and idempotent; key names are kept so the event stays
 * useful, only values are replaced.
 */

export const REDACTED_ENV_VALUE = "[redacted]";

/** Env names that are always secret, regardless of the name patterns below. */
const KNOWN_SECRET_ENV_NAMES: ReadonlySet<string> = new Set([
  "CODEX_POOL_AUTH_TOKEN",
  "CODEX_POOL_BASE_URL",
  "BB_ACCOUNT_POOL_PARENT_TOKEN",
  "BB_ACCOUNT_POOL_PARENT_URL",
]);

const SECRET_ENV_NAME_PATTERN =
  /TOKEN|SECRET|KEY|PASSWORD|PASSWD|PASSPHRASE|CREDENTIAL|BEARER|AUTH|COOKIE|PRIVATE|POOL/i;

/** Secrets must be at least this long to be scrubbed out of other values. */
const MIN_CROSS_REFERENCE_SECRET_LENGTH = 8;

export function isSecretEnvName(name: string): boolean {
  return (
    KNOWN_SECRET_ENV_NAMES.has(name) || SECRET_ENV_NAME_PATTERN.test(name)
  );
}

const URL_USERINFO_PATTERN = /(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi;
const BEARER_PATTERN = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi;
const SECRET_ASSIGNMENT_PATTERN =
  /((?:^|[\s?&;,'"])-{0,2}[\w.-]*(?:token|secret|key|password|passwd|credential|auth)[\w.-]*\s*[=:]\s*)[^\s&;,'"]+/gi;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function scrubSecretShapes(text: string): string {
  return text
    .replace(URL_USERINFO_PATTERN, `$1${REDACTED_ENV_VALUE}@`)
    .replace(BEARER_PATTERN, `$1 ${REDACTED_ENV_VALUE}`)
    .replace(SECRET_ASSIGNMENT_PATTERN, `$1${REDACTED_ENV_VALUE}`);
}

function scrubKnownSecrets(
  text: string,
  secretPattern: RegExp | null,
): string {
  const scrubbed = secretPattern
    ? text.replace(secretPattern, REDACTED_ENV_VALUE)
    : text;
  return scrubSecretShapes(scrubbed);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Returns a copy of a `provider.env-resolved` payload (stored `data` or a full
 * event; only `entries` is inspected) with secret values replaced. Returns the
 * input untouched when it has no `entries` array.
 */
export function redactProviderEnvResolvedData<T extends object>(data: T): T {
  const record = { ...data } as Record<string, unknown>;
  const entries = record.entries;
  if (!Array.isArray(entries)) {
    return data;
  }

  const secretValues: string[] = [];
  for (const entry of entries) {
    if (
      isRecord(entry) &&
      typeof entry.name === "string" &&
      typeof entry.value === "string" &&
      isSecretEnvName(entry.name) &&
      entry.value.length >= MIN_CROSS_REFERENCE_SECRET_LENGTH &&
      entry.value !== REDACTED_ENV_VALUE
    ) {
      secretValues.push(entry.value);
    }
  }
  const secretPattern =
    secretValues.length === 0
      ? null
      : new RegExp(
          [...new Set(secretValues)]
            .sort((a, b) => b.length - a.length)
            .map(escapeRegExp)
            .join("|"),
          "g",
        );

  record.entries = entries.map((entry) => {
    if (!isRecord(entry)) {
      return entry;
    }
    const next: Record<string, unknown> = { ...entry };
    if (typeof entry.value === "string") {
      next.value =
        typeof entry.name === "string" && isSecretEnvName(entry.name)
          ? REDACTED_ENV_VALUE
          : scrubKnownSecrets(entry.value, secretPattern);
    }
    if (typeof entry.reason === "string") {
      next.reason = scrubKnownSecrets(entry.reason, secretPattern);
    }
    return next;
  });
  return record as T;
}

/** Applies the event-type specific redaction to a stored/emitted payload. */
export function redactEventDataForType<T extends object>(
  type: string,
  data: T,
): T {
  return type === "provider.env-resolved"
    ? redactProviderEnvResolvedData(data)
    : data;
}

/**
 * JSON-string variant for write paths that hold serialized `data`. Unparseable
 * or non-object payloads are returned unchanged.
 */
export function redactEventDataJsonForType(type: string, json: string): string {
  if (type !== "provider.env-resolved") {
    return json;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return json;
  }
  if (!isRecord(parsed)) {
    return json;
  }
  return JSON.stringify(redactProviderEnvResolvedData(parsed));
}
