/**
 * Credential redaction for event payloads.
 *
 * Every event type is covered by a generic deep walk
 * (`sanitizeCredentialsDeep`): values under secret-named keys, children of
 * env/envVars/headers maps and `{name, value}` pairs with secret names are
 * replaced, and (for diagnostic-style types) secret-looking strings are
 * scrubbed. Content-bearing types (messages, tool output) only get the
 * key/container based rules so user-visible text stays intact.
 *
 * Original doc for `provider.env-resolved`:
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
  return KNOWN_SECRET_ENV_NAMES.has(name) || SECRET_ENV_NAME_PATTERN.test(name);
}

const SECRET_WORDS =
  "token|secret|key|password|passwd|passphrase|credential|auth|cookie|signature";
const URL_USERINFO_PATTERN = /(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi;
const BEARER_PATTERN = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi;
/** `Authorization: ...`, `Cookie: a=b; c=d` etc.: redact to end of line. */
const SECRET_HEADER_PATTERN =
  /((?:^|[\s,;{(\\"'])(?:proxy-)?(?:authorization|cookie|set-cookie|x-api-key|x-auth-token|x-access-token)\s*:)(?![ \t]*\[redacted\])([ \t]*)[^\r\n"']+/gi;
/** `"apiKey": "x"` / escaped `\"apiKey\":\"x\"` inside embedded JSON. */
const JSON_SECRET_PAIR_PATTERN = new RegExp(
  `(\\\\*"[\\w.-]*(?:${SECRET_WORDS})[\\w.-]*\\\\*"\\s*:\\s*)(\\\\*"(?:[^"\\\\]|\\\\[^"])*\\\\*"|[^\\s,}\\]]+)`,
  "gi",
);
/** `--api-key X` / `--token X` (flag-style, space separated). */
const SECRET_FLAG_PATTERN = new RegExp(
  `((?:^|[\\s'"])-{1,2}[\\w.-]*(?:${SECRET_WORDS})[\\w.-]*\\s+)(?!-)("[^"]*"|'[^']*'|[^\\s&;,'"]+)`,
  "gi",
);
/** `NAME=value`, `NAME: value`, `--flag="value"`, `KEY='value'`, `?sig=value`. */
const SECRET_ASSIGNMENT_PATTERN = new RegExp(
  `((?:^|[\\s?&;,'"({\\[])-{0,2}[\\w.-]*(?:${SECRET_WORDS}|sig)[\\w.-]*\\s*[=:])(?!\\s*\\[redacted\\])(\\s*)("[^"]*"|'[^']*'|[^\\s&;,'"]+)`,
  "gi",
);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function scrubSecretShapes(text: string): string {
  return text
    .replace(SECRET_HEADER_PATTERN, `$1$2${REDACTED_ENV_VALUE}`)
    .replace(JSON_SECRET_PAIR_PATTERN, (_m, key: string, value: string) =>
      value.trim().startsWith("\\") || key.includes("\\")
        ? `${key}\\"${REDACTED_ENV_VALUE}\\"`
        : `${key}"${REDACTED_ENV_VALUE}"`,
    )
    .replace(URL_USERINFO_PATTERN, `$1${REDACTED_ENV_VALUE}@`)
    .replace(BEARER_PATTERN, `$1 ${REDACTED_ENV_VALUE}`)
    .replace(SECRET_FLAG_PATTERN, `$1${REDACTED_ENV_VALUE}`)
    .replace(SECRET_ASSIGNMENT_PATTERN, `$1$2${REDACTED_ENV_VALUE}`);
}

function scrubKnownSecrets(text: string, secretPattern: RegExp | null): string {
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

// ---------------------------------------------------------------------------
// Generic deep sanitizer
// ---------------------------------------------------------------------------

const MAX_SANITIZE_DEPTH = 64;
const MAX_SANITIZE_NODES = 200_000;

/** Keys whose child entries are named env vars / HTTP headers. */
const ENV_CONTAINER_KEYS: ReadonlySet<string> = new Set([
  "env",
  "envvars",
  "environment",
  "headers",
  "requestheaders",
  "responseheaders",
  "httpheaders",
  "extraheaders",
]);

const SECRET_KEY_PATTERN =
  /(token|secret|password|passwd|passphrase|credentials?|apikey|privatekey|authorization|cookie)$|^(auth|bearer|signature|sig)$/;

/** Conservative raw-JSON precheck for key/container based redaction. */
const KEY_REDACTION_PRECHECK =
  /\\u|\\?"(?:[^"\\]*(?:token|secret|passw|passphrase|credential|api[-_. ]?key|private[-_. ]?key|authorization|cookie|auth|bearer|signature)[^"\\]*|sig|env|env[-_. ]?vars|environment|(?:request|response|http|extra)?[-_. ]?headers)\\?"\s*:/i;

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[-_.\s]/g, "");
}

/** Whether a payload key (not an env name) holds a secret value. */
function isSecretPayloadKey(key: string): boolean {
  return SECRET_KEY_PATTERN.test(normalizeKey(key));
}

/** Types whose string fields are diagnostics rather than user content. */
function isFreeTextScrubType(type: string): boolean {
  return (
    type.startsWith("provider/") ||
    type.startsWith("provider.") ||
    type.startsWith("client/") ||
    (type.startsWith("system/") && type !== "system/manager/user_message") ||
    type === "turn/completed"
  );
}

interface SanitizeState {
  freeText: boolean;
  changed: boolean;
  nodes: number;
  secrets: Set<string>;
}

type WalkMode = "plain" | "env" | "force";

function redactLeaf(state: SanitizeState, original: string): string {
  if (original === REDACTED_ENV_VALUE) {
    return original;
  }
  state.changed = true;
  if (original.length >= MIN_CROSS_REFERENCE_SECRET_LENGTH) {
    state.secrets.add(original);
  }
  return REDACTED_ENV_VALUE;
}

function walkSanitize(
  value: unknown,
  state: SanitizeState,
  depth: number,
  mode: WalkMode,
): unknown {
  if (typeof value === "string") {
    if (mode === "force") {
      return redactLeaf(state, value);
    }
    if (!state.freeText) {
      return value;
    }
    const scrubbed = scrubSecretShapes(value);
    if (scrubbed !== value) {
      state.changed = true;
    }
    return scrubbed;
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  state.nodes += 1;
  if (depth > MAX_SANITIZE_DEPTH || state.nodes > MAX_SANITIZE_NODES) {
    // Fail closed on pathological payloads.
    state.changed = true;
    return REDACTED_ENV_VALUE;
  }
  if (Array.isArray(value)) {
    return value.map((item) =>
      walkSanitize(item, state, depth + 1, mode === "env" ? "plain" : mode),
    );
  }
  const record = value as Record<string, unknown>;
  const next: Record<string, unknown> = {};
  const pairName =
    typeof record.name === "string" &&
    typeof record.value === "string" &&
    (state.freeText || mode === "env") &&
    isSecretEnvName(record.name);
  for (const [key, child] of Object.entries(record)) {
    if (pairName && key === "value") {
      next[key] = redactLeaf(state, child as string);
      continue;
    }
    if (mode === "env" && typeof child === "string" && isSecretEnvName(key)) {
      next[key] = redactLeaf(state, child);
      continue;
    }
    if (mode !== "force" && isSecretPayloadKey(key)) {
      if (typeof child === "string") {
        next[key] = redactLeaf(state, child);
        continue;
      }
      if (isRecord(child) || Array.isArray(child)) {
        next[key] = walkSanitize(child, state, depth + 1, "force");
        continue;
      }
    }
    const childMode: WalkMode =
      mode === "force"
        ? "force"
        : ENV_CONTAINER_KEYS.has(normalizeKey(key)) && isRecord(child)
          ? "env"
          : "plain";
    next[key] = walkSanitize(child, state, depth + 1, childMode);
  }
  return next;
}

function scrubKnownSecretsDeep(
  value: unknown,
  pattern: RegExp,
  depth: number,
): unknown {
  if (typeof value === "string") {
    return value === REDACTED_ENV_VALUE
      ? value
      : value.replace(pattern, REDACTED_ENV_VALUE);
  }
  if (
    typeof value !== "object" ||
    value === null ||
    depth > MAX_SANITIZE_DEPTH
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => scrubKnownSecretsDeep(item, pattern, depth + 1));
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      scrubKnownSecretsDeep(child, pattern, depth + 1),
    ]),
  );
}

/**
 * Deep-copies `value` with credentials replaced. Returns the input itself
 * when nothing needed redaction. `freeText` additionally scrubs
 * secret-looking substrings (bearer tokens, `--api-key X`, embedded JSON,
 * cookie headers, ...) out of every string.
 */
export function sanitizeCredentialsDeep<T>(
  value: T,
  options: { freeText: boolean },
): T {
  const state: SanitizeState = {
    freeText: options.freeText,
    changed: false,
    nodes: 0,
    secrets: new Set(),
  };
  let result = walkSanitize(value, state, 0, "plain");
  if (state.secrets.size > 0) {
    const pattern = new RegExp(
      [...state.secrets]
        .sort((a, b) => b.length - a.length)
        .map(escapeRegExp)
        .join("|"),
      "g",
    );
    result = scrubKnownSecretsDeep(result, pattern, 0);
  }
  return state.changed ? (result as T) : value;
}

/** Applies credential redaction to a stored/emitted payload of any type. */
export function redactEventDataForType<T extends object>(
  type: string,
  data: T,
): T {
  const base =
    type === "provider.env-resolved"
      ? redactProviderEnvResolvedData(data)
      : data;
  return sanitizeCredentialsDeep(base, { freeText: isFreeTextScrubType(type) });
}

/**
 * JSON-string variant for write paths that hold serialized `data`. Unparseable
 * or non-object payloads are returned unchanged.
 */
export function redactEventDataJsonForType(type: string, json: string): string {
  // Hot write path (output deltas, tool output): skip the parse when the raw
  // text has no secret-named key, env/header container or escaped key.
  if (!isFreeTextScrubType(type) && !KEY_REDACTION_PRECHECK.test(json)) {
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
  const redacted = redactEventDataForType(type, parsed);
  return redacted === parsed ? json : JSON.stringify(redacted);
}

/**
 * Key/container based redaction of one serialized JSON line (no free-text
 * scrubbing, so recorded provider output stays faithful). Non-JSON lines are
 * returned unchanged.
 */
export function redactCredentialsInJsonLine(line: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return line;
  }
  const redacted = sanitizeCredentialsDeep(parsed, { freeText: false });
  return redacted === parsed ? line : JSON.stringify(redacted);
}
