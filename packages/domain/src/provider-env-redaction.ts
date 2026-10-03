/**
 * Credential redaction for event payloads.
 *
 * Every event type goes through one deep walk (`sanitizeCredentialsDeep`)
 * with a per-type policy (`policyForType`):
 *
 * - diagnostics (provider/*, system/*, ...): secret-named keys anywhere,
 *   env/headers containers (object or array form) and full free-text
 *   scrubbing (flags, assignments, embedded JSON, headers, bearer, ...);
 * - tool content (item/* other than authored messages): credential
 *   containers only (env/headers), plus header/userinfo/strong-bearer text
 *   scrubbing, so ordinary tool output and schema-like fields survive;
 * - authored content (user prompts, assistant text, ...): credential
 *   containers only, text untouched.
 *
 * Event envelope fields (`type`, `threadId`, `scope`, ...) are never altered,
 * and every pass is linear in the payload size.
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

/**
 * Free-text scrubbing. Every pattern below is anchored so a scan can only
 * start at a token boundary (lookbehind) and no two variable-length parts
 * overlap, so each pass is linear in the input even for adversarial text
 * (`token token ...`, `a.a.a.a`, long backslash runs, ...). Key words are
 * checked in code (`isSecretTextKey`) instead of inside the regex, which is
 * what made the earlier alternation-around-a-word patterns quadratic.
 */
const URL_USERINFO_PATTERN =
  /(?<![a-z0-9+.-])([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi;
const BEARER_PATTERN = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi;
/** Tool text: only a bearer token that is clearly a credential, not prose. */
const STRONG_BEARER_PATTERN = /\b(Bearer)\s+[A-Za-z0-9._~+/=-]{16,}/gi;
/**
 * `Authorization: ...`, `Cookie: a=b; c="d"` etc.: redact to end of line. A
 * quoted segment is only consumed right after `=` so a closing quote of the
 * surrounding string/shell quoting still ends the value.
 */
const SECRET_HEADER_PATTERN =
  /((?:^|[\s,;{(\\"'])(?:proxy-)?(?:authorization|cookie|set-cookie|x-api-key|x-auth-token|x-access-token)\s*:)(?![ \t]*\[redacted\])([ \t]*)(?:(?:"[^"\r\n]*"|'[^'\r\n]*')(?:=\s*"[^"\r\n]*"|=\s*'[^'\r\n]*'|[^\r\n"'])*|(?:=\s*"[^"\r\n]*"|=\s*'[^'\r\n]*'|[^\r\n"'])+)/gi;
/** Opening of an embedded JSON pair: `"apiKey":` / `\"apiKey\":` / `"apiKey":`. */
const JSON_KEY_PATTERN =
  /(?<!\\)(\\*"(?:[\w.-]|\\u[0-9a-fA-F]{4})+\\*"\s*:\s*)/g;
const JSON_PLAIN_VALUE_PATTERN = /"(?:[^"\\]|\\.)*"|[^\s,}\]]+/y;
const JSON_ESCAPED_QUOTE_PATTERN = /\\+"/y;
const JSON_ESCAPED_CLOSE_PATTERN = /(?<!\\)\\+"/g;
const JSON_SCALAR_VALUE_PATTERN = /[^\s,}\]]+/y;
/** `--api-key X` / `--token X` (flag-style, space separated). */
const SECRET_FLAG_PATTERN =
  /(?<=^|[\s'"])(-{1,2}[\w.-]+\s+)(?!-)("[^"]*"|'[^']*'|[^\s&;,'"]+)/g;
/** `NAME=value`, `NAME: value`, `--flag="value"`, `KEY='value'`, `?sig=value`. */
const SECRET_ASSIGNMENT_PATTERN =
  /(?<=^|[\s?&;,'"({\[])(-{0,2}[\w.-]+\s*[=:])(?!\s*\[redacted\])(\s*)("[^"]*"|'[^']*'|[^\s&;,'"]+)/g;

const SECRET_TEXT_KEY_PATTERN =
  /token|secret|passw|passphrase|credential|cookie|signature|authoriz|authentic|key|bearer/i;
const SECRET_TEXT_KEY_SEGMENTS: ReadonlySet<string> = new Set([
  "auth",
  "oauth",
  "sig",
]);

/**
 * Whether a name found in free text (flag, assignment, embedded JSON key)
 * is a credential name. `auth`/`sig` only count as whole name segments so
 * `author` and `design` are not credentials.
 */
function isSecretTextKey(rawKey: string): boolean {
  const key = rawKey
    .replace(/\\u([0-9a-fA-F]{4})/g, (_m, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    )
    .replace(/^-+/, "");
  if (SECRET_TEXT_KEY_PATTERN.test(key)) {
    return true;
  }
  return key
    .split(/[^A-Za-z0-9]+|(?<=[a-z0-9])(?=[A-Z])/)
    .some((segment) => SECRET_TEXT_KEY_SEGMENTS.has(segment.toLowerCase()));
}

/**
 * Linear replace loop: `replacer` returns the replacement or `null` to skip
 * (not a credential), in which case scanning resumes right after the match
 * prefix (`m[1]`) so nested matches are still found.
 */
function replaceScanning(
  text: string,
  pattern: RegExp,
  replacer: (match: RegExpExecArray) => string | null,
): string {
  pattern.lastIndex = 0;
  let out = "";
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const replacement = replacer(match);
    if (replacement === null) {
      pattern.lastIndex = match.index + Math.max(1, match[1]?.length ?? 1);
      continue;
    }
    out += text.slice(last, match.index) + replacement;
    last = match.index + match[0].length;
    if (match[0].length === 0) {
      pattern.lastIndex += 1;
    }
  }
  pattern.lastIndex = 0;
  return out + text.slice(last);
}

/** End index of the JSON value starting at `pos`, or -1 when there is none. */
function findJsonValueEnd(text: string, pos: number, escaped: boolean): number {
  if (escaped) {
    JSON_ESCAPED_QUOTE_PATTERN.lastIndex = pos;
    if (JSON_ESCAPED_QUOTE_PATTERN.exec(text) === null) {
      return matchSticky(JSON_SCALAR_VALUE_PATTERN, text, pos);
    }
    JSON_ESCAPED_CLOSE_PATTERN.lastIndex = text.indexOf('"', pos) + 1;
    const close = JSON_ESCAPED_CLOSE_PATTERN.exec(text);
    JSON_ESCAPED_CLOSE_PATTERN.lastIndex = 0;
    return close === null ? -1 : close.index + close[0].length;
  }
  return matchSticky(JSON_PLAIN_VALUE_PATTERN, text, pos);
}

function matchSticky(pattern: RegExp, text: string, pos: number): number {
  pattern.lastIndex = pos;
  const match = pattern.exec(text);
  return match === null ? -1 : pos + match[0].length;
}

function scrubJsonSecretPairs(text: string): string {
  JSON_KEY_PATTERN.lastIndex = 0;
  let out = "";
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = JSON_KEY_PATTERN.exec(text)) !== null) {
    const prefix = match[1] ?? "";
    const valueStart = match.index + prefix.length;
    const keyName = prefix.replace(/^\\*"|\\*"\s*:\s*$/g, "");
    if (!isSecretTextKey(keyName)) {
      continue;
    }
    const escaped = prefix.includes("\\") || text[valueStart] === "\\";
    const valueEnd = findJsonValueEnd(text, valueStart, escaped);
    if (valueEnd < 0) {
      continue;
    }
    out +=
      text.slice(last, valueStart) +
      (escaped ? `\\"${REDACTED_ENV_VALUE}\\"` : `"${REDACTED_ENV_VALUE}"`);
    last = valueEnd;
    JSON_KEY_PATTERN.lastIndex = valueEnd;
  }
  JSON_KEY_PATTERN.lastIndex = 0;
  return out + text.slice(last);
}

function scrubToolText(text: string): string {
  return text
    .replace(SECRET_HEADER_PATTERN, `$1$2${REDACTED_ENV_VALUE}`)
    .replace(URL_USERINFO_PATTERN, `$1${REDACTED_ENV_VALUE}@`)
    .replace(STRONG_BEARER_PATTERN, `$1 ${REDACTED_ENV_VALUE}`);
}

function scrubSecretShapes(text: string): string {
  return replaceScanning(
    replaceScanning(
      scrubJsonSecretPairs(
        text.replace(SECRET_HEADER_PATTERN, `$1$2${REDACTED_ENV_VALUE}`),
      )
        .replace(URL_USERINFO_PATTERN, `$1${REDACTED_ENV_VALUE}@`)
        .replace(BEARER_PATTERN, `$1 ${REDACTED_ENV_VALUE}`),
      SECRET_FLAG_PATTERN,
      (m) =>
        isSecretTextKey(m[1] ?? "") ? `${m[1]}${REDACTED_ENV_VALUE}` : null,
    ),
    SECRET_ASSIGNMENT_PATTERN,
    (m) =>
      isSecretTextKey((m[1] ?? "").replace(/\s*[=:]$/, ""))
        ? `${m[1]}${m[2]}${REDACTED_ENV_VALUE}`
        : null,
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

/** Only payload subtrees nested deeper than this are replaced wholesale. */
const MAX_SANITIZE_DEPTH = 64;
/** Cross-reference at most this many distinct leaked secrets per payload. */
const MAX_CROSS_REFERENCE_SECRETS = 256;

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

/** Event fields outside the payload; never inspected or rewritten. */
const EVENT_ENVELOPE_KEYS: ReadonlySet<string> = new Set([
  "type",
  "threadId",
  "providerThreadId",
  "scope",
  "turnId",
]);

const SECRET_KEY_PATTERN =
  /(token|secret|password|passwd|passphrase|credentials?|apikey|privatekey|authorization|cookie)$|^(auth|bearer|signature|sig)$/;

/** Literal-substring precheck (linear) for the raw-JSON fast path. */
const JSON_PRECHECK_PATTERN =
  /token|secret|passw|credential|api[-_. ]?key|private[-_. ]?key|authoriz|cookie|auth|bearer|signature|"sig"|env|headers|x-api-key|\\u|:\/\//i;

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[-_.\s]/g, "");
}

/** Whether a payload key (not an env name) holds a secret value. */
function isSecretPayloadKey(key: string): boolean {
  return SECRET_KEY_PATTERN.test(normalizeKey(key));
}

export type CredentialKeyScope = "anywhere" | "containers";
export type CredentialTextScrub = "full" | "tool" | "none";

export interface CredentialRedactionPolicy {
  keys: CredentialKeyScope;
  text: CredentialTextScrub;
}

const AUTHORED_ITEM_TYPE_PATTERN =
  /^item\/(agentMessage|userMessage|reasoning|plan)(\/|$)/;

/** Which redaction rules apply to an event type (see file header). */
export function policyForType(type: string): CredentialRedactionPolicy {
  if (
    type.startsWith("provider/") ||
    type.startsWith("provider.") ||
    type === "client/thread/start" ||
    (type.startsWith("system/") && type !== "system/manager/user_message") ||
    type === "turn/completed"
  ) {
    return { keys: "anywhere", text: "full" };
  }
  if (type.startsWith("item/") && !AUTHORED_ITEM_TYPE_PATTERN.test(type)) {
    return { keys: "containers", text: "tool" };
  }
  return { keys: "containers", text: "none" };
}

interface SanitizeState {
  keys: CredentialKeyScope;
  text: CredentialTextScrub;
  envelopeKeys: ReadonlySet<string> | null;
  changed: boolean;
  secrets: Set<string>;
}

type WalkMode = "plain" | "env" | "envList" | "force";

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

function scrubText(state: SanitizeState, value: string): string {
  if (state.text === "none") {
    return value;
  }
  const scrubbed =
    state.text === "full" ? scrubSecretShapes(value) : scrubToolText(value);
  if (scrubbed !== value) {
    state.changed = true;
  }
  return scrubbed;
}

/** Redacts a value known to be a secret, keeping the shape of containers. */
function redactSecretValue(
  state: SanitizeState,
  value: unknown,
  depth: number,
): unknown {
  if (typeof value === "string") {
    return redactLeaf(state, value);
  }
  if (typeof value === "object" && value !== null) {
    return walkSanitize(value, state, depth, "force");
  }
  return value;
}

function sanitizeEnvListItem(
  item: unknown,
  state: SanitizeState,
  depth: number,
): unknown {
  if (typeof item === "string") {
    const eq = item.indexOf("=");
    if (eq > 0 && isSecretEnvName(item.slice(0, eq))) {
      const value = item.slice(eq + 1);
      return value === "" || value === REDACTED_ENV_VALUE
        ? item
        : `${item.slice(0, eq + 1)}${redactLeaf(state, value)}`;
    }
    return scrubText(state, item);
  }
  if (Array.isArray(item)) {
    // `[name, value]` tuple (e.g. headers: [["Authorization", "Bearer x"]]).
    if (item.length === 2 && typeof item[0] === "string") {
      return [
        item[0],
        isSecretEnvName(item[0])
          ? redactSecretValue(state, item[1], depth + 1)
          : walkSanitize(item[1], state, depth + 1, "plain"),
      ];
    }
    return walkSanitize(item, state, depth, "plain");
  }
  return walkSanitize(item, state, depth, "env");
}

function walkSanitize(
  value: unknown,
  state: SanitizeState,
  depth: number,
  mode: WalkMode,
): unknown {
  if (typeof value === "string") {
    return mode === "force"
      ? redactLeaf(state, value)
      : scrubText(state, value);
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  if (depth > MAX_SANITIZE_DEPTH) {
    // Fail closed on pathologically deep subtrees (never reached by the
    // envelope, which sits at depth 0/1).
    state.changed = true;
    return REDACTED_ENV_VALUE;
  }
  if (Array.isArray(value)) {
    if (mode === "envList") {
      return value.map((item) => sanitizeEnvListItem(item, state, depth + 1));
    }
    return value.map((item) =>
      walkSanitize(
        item,
        state,
        depth + 1,
        mode === "force" ? "force" : "plain",
      ),
    );
  }
  const record = value as Record<string, unknown>;
  const next: Record<string, unknown> = {};
  const pairName =
    mode !== "force" && (mode === "env" || state.keys === "anywhere")
      ? typeof record.name === "string"
        ? record.name
        : mode === "env" && typeof record.key === "string"
          ? record.key
          : null
      : null;
  const pairIsSecret =
    pairName !== null && "value" in record && isSecretEnvName(pairName);
  for (const [key, child] of Object.entries(record)) {
    if (depth === 0 && state.envelopeKeys?.has(key)) {
      next[key] = child;
      continue;
    }
    if (pairIsSecret && key === "value") {
      next[key] = redactSecretValue(state, child, depth + 1);
      continue;
    }
    if (mode === "env" && isSecretEnvName(key)) {
      if (typeof child === "string" || isContainer(child)) {
        next[key] = redactSecretValue(state, child, depth + 1);
        continue;
      }
    }
    if (
      mode !== "force" &&
      state.keys === "anywhere" &&
      isSecretPayloadKey(key) &&
      (typeof child === "string" || isContainer(child))
    ) {
      next[key] = redactSecretValue(state, child, depth + 1);
      continue;
    }
    let childMode: WalkMode = mode === "force" ? "force" : "plain";
    if (mode !== "force" && ENV_CONTAINER_KEYS.has(normalizeKey(key))) {
      if (Array.isArray(child)) {
        childMode = "envList";
      } else if (isRecord(child)) {
        childMode = "env";
      }
    }
    next[key] = walkSanitize(child, state, depth + 1, childMode);
  }
  return next;
}

function isContainer(value: unknown): value is object {
  return typeof value === "object" && value !== null;
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
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    out[key] = scrubKnownSecretsDeep(child, pattern, depth + 1);
  }
  return out;
}

export interface SanitizeCredentialsOptions {
  /** `true` is the full diagnostic scrub, `false` none. */
  freeText: boolean | CredentialTextScrub;
  keys?: CredentialKeyScope;
  /** Top-level fields copied through untouched (full events only). */
  envelopeKeys?: ReadonlySet<string>;
}

/**
 * Deep-copies `value` with credentials replaced. Returns the input itself
 * when nothing needed redaction.
 */
export function sanitizeCredentialsDeep<T>(
  value: T,
  options: SanitizeCredentialsOptions,
): T {
  const state: SanitizeState = {
    keys: options.keys ?? "anywhere",
    text:
      options.freeText === true
        ? "full"
        : options.freeText === false
          ? "none"
          : options.freeText,
    envelopeKeys: options.envelopeKeys ?? null,
    changed: false,
    secrets: new Set(),
  };
  let result = walkSanitize(value, state, 0, "plain");
  if (state.secrets.size > 0) {
    const secrets = [...state.secrets]
      .sort((a, b) => b.length - a.length)
      .slice(0, MAX_CROSS_REFERENCE_SECRETS);
    const pattern = new RegExp(secrets.map(escapeRegExp).join("|"), "g");
    result = scrubKnownSecretsDeep(result, pattern, 0);
    if (state.envelopeKeys !== null && isRecord(value) && isRecord(result)) {
      for (const key of state.envelopeKeys) {
        if (key in value) {
          result[key] = value[key];
        }
      }
    }
  }
  return state.changed ? (result as T) : value;
}

function sanitizeForType<T extends object>(
  type: string,
  data: T,
  envelopeKeys: ReadonlySet<string> | null,
): T {
  const base =
    type === "provider.env-resolved"
      ? redactProviderEnvResolvedData(data)
      : data;
  const policy = policyForType(type);
  return sanitizeCredentialsDeep(base, {
    freeText: policy.text,
    keys: policy.keys,
    ...(envelopeKeys ? { envelopeKeys } : {}),
  });
}

/** Applies credential redaction to a stored/emitted payload of any type. */
export function redactEventDataForType<T extends object>(
  type: string,
  data: T,
): T {
  return sanitizeForType(type, data, null);
}

/**
 * Applies credential redaction to a full event (emit / daemon sink). The
 * envelope (`type`, `threadId`, `providerThreadId`, `scope`, `turnId`) is
 * copied through untouched so the event stays valid for downstream schemas.
 */
export function redactThreadEventPayload<T extends { type: string }>(
  event: T,
): T {
  return sanitizeForType(event.type, event, EVENT_ENVELOPE_KEYS);
}

/**
 * JSON-string variant for write paths that hold serialized `data`. Unparseable
 * or non-object payloads are returned unchanged.
 */
export function redactEventDataJsonForType(type: string, json: string): string {
  // Hot write path (output deltas, tool output): skip the parse when the raw
  // text mentions nothing credential-shaped at all.
  if (
    policyForType(type).keys === "containers" &&
    !JSON_PRECHECK_PATTERN.test(json)
  ) {
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
