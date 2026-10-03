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

import type { ThreadEventType } from "./provider-event.js";
import {
  STRUCTURAL_ARRAY_KEY,
  getStructuralRoot,
  isStructuralTerminal,
  stepStructural,
  type StructuralNode,
} from "./thread-event-structure.js";

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
 * Names of credential headers: `Authorization:`, `Cookie:`, ... The value is
 * scanned in code (`scanHeaderValueEnd`) because it can contain quoted
 * segments, escaped quotes (embedded JSON text) and unterminated quotes.
 */
const SECRET_HEADER_NAME_PATTERN =
  /((?:^|[\s,;{(\\"'])(?:proxy-)?(?:authorization|cookie|set-cookie|x-api-key|x-auth-token|x-access-token)\s*:)(?![ \t]*\[redacted\])([ \t]*)/gi;
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

const BACKSLASH = 92;
const DOUBLE_QUOTE = 34;
const SINGLE_QUOTE = 39;
const EQUALS = 61;

function isLineBreak(code: number): boolean {
  return code === 10 || code === 13;
}

/** End of a plain quoted segment; the end of the line when unterminated. */
function findPlainQuoteEnd(text: string, from: number, quote: number): number {
  for (let i = from; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (isLineBreak(code)) {
      return i;
    }
    if (code === quote) {
      return i + 1;
    }
  }
  return text.length;
}

/**
 * End of an escaped quoted segment (`\"...\"` inside embedded JSON text).
 * A bare quote or the end of the line ends an unterminated segment, so the
 * quote that closes the surrounding JSON string is left alone.
 */
function findEscapedQuoteEnd(
  text: string,
  from: number,
  quote: number,
): number {
  let backslashes = 0;
  for (let i = from; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (isLineBreak(code)) {
      return i;
    }
    if (code === BACKSLASH) {
      backslashes += 1;
      continue;
    }
    if (code === quote) {
      return backslashes > 0 ? i + 1 : i;
    }
    backslashes = 0;
  }
  return text.length;
}

/**
 * End of a header value starting at `start`: to the end of the line, except
 * that a quote which does not open a quoted segment (right after `=` or at
 * the start of the value) ends it, as the closing quote of the surrounding
 * string or shell quoting. Unterminated quoted segments run to the end of
 * the line.
 */
function scanHeaderValueEnd(text: string, start: number): number {
  let i = start;
  let opensSegment = true;
  while (i < text.length) {
    const code = text.charCodeAt(i);
    if (isLineBreak(code)) {
      break;
    }
    if (code === BACKSLASH) {
      let j = i;
      while (j < text.length && text.charCodeAt(j) === BACKSLASH) {
        j += 1;
      }
      const next = j < text.length ? text.charCodeAt(j) : -1;
      if (next === DOUBLE_QUOTE || next === SINGLE_QUOTE) {
        if (!opensSegment) {
          break;
        }
        i = findEscapedQuoteEnd(text, j + 1, next);
        opensSegment = false;
        continue;
      }
      i = j;
      opensSegment = false;
      continue;
    }
    if (code === DOUBLE_QUOTE || code === SINGLE_QUOTE) {
      if (!opensSegment) {
        break;
      }
      i = findPlainQuoteEnd(text, i + 1, code);
      opensSegment = false;
      continue;
    }
    opensSegment = code === EQUALS || (opensSegment && (code === 32 || code === 9));
    i += 1;
  }
  return i;
}

function scrubSecretHeaders(text: string): string {
  const pattern = SECRET_HEADER_NAME_PATTERN;
  pattern.lastIndex = 0;
  let out = "";
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const valueStart = match.index + match[0].length;
    const valueEnd = scanHeaderValueEnd(text, valueStart);
    if (valueEnd === valueStart) {
      continue;
    }
    out +=
      text.slice(last, valueStart) + REDACTED_ENV_VALUE;
    last = valueEnd;
    pattern.lastIndex = valueEnd;
  }
  pattern.lastIndex = 0;
  return out + text.slice(last);
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
  return scrubSecretHeaders(text)
    .replace(URL_USERINFO_PATTERN, `$1${REDACTED_ENV_VALUE}@`)
    .replace(STRONG_BEARER_PATTERN, `$1 ${REDACTED_ENV_VALUE}`);
}

function scrubSecretShapes(text: string): string {
  return replaceScanning(
    replaceScanning(
      scrubJsonSecretPairs(
        scrubSecretHeaders(text),
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

/** Secrets beyond this many characters fail closed (see `SecretMatcher`). */
const MAX_CROSS_REFERENCE_SECRET_CHARS = 4 * 1024 * 1024;

/**
 * Replaces every occurrence of any known secret in a string, in one linear
 * pass (Aho-Corasick), for any number of secrets. Overlapping occurrences are
 * merged into a single replacement, so no part of a secret survives.
 */
class SecretMatcher {
  private readonly goto = new Map<number, number>();
  private readonly fail: number[] = [0];
  private readonly best: number[] = [0];
  private readonly maxLength: number;
  private readonly minLength: number;

  private constructor(secrets: readonly string[]) {
    const terminal: number[] = [0];
    const parent: number[] = [0];
    const edge: number[] = [0];
    const depth: number[] = [0];
    let minLength = Infinity;
    let maxLength = 0;
    for (const secret of secrets) {
      minLength = Math.min(minLength, secret.length);
      maxLength = Math.max(maxLength, secret.length);
      let node = 0;
      for (let i = 0; i < secret.length; i += 1) {
        const code = secret.charCodeAt(i);
        const key = node * 65536 + code;
        let next = this.goto.get(key);
        if (next === undefined) {
          next = terminal.length;
          this.goto.set(key, next);
          terminal.push(0);
          parent.push(node);
          edge.push(code);
          depth.push(depth[node]! + 1);
        }
        node = next;
      }
      terminal[node] = secret.length;
    }
    this.minLength = minLength;
    this.maxLength = maxLength;

    // Failure links in nondecreasing depth order (counting sort by depth).
    const counts = new Array<number>(maxLength + 2).fill(0);
    for (let node = 1; node < terminal.length; node += 1) {
      counts[depth[node]! + 1]! += 1;
    }
    for (let d = 1; d < counts.length; d += 1) {
      counts[d]! += counts[d - 1]!;
    }
    const order = new Array<number>(terminal.length - 1);
    for (let node = 1; node < terminal.length; node += 1) {
      order[counts[depth[node]!]!++] = node;
    }
    this.fail = new Array<number>(terminal.length).fill(0);
    this.best = new Array<number>(terminal.length).fill(0);
    for (const node of order) {
      const code = edge[node]!;
      let link = 0;
      if (parent[node] !== 0) {
        let candidate = this.fail[parent[node]!]!;
        for (;;) {
          const next = this.goto.get(candidate * 65536 + code);
          if (next !== undefined && next !== node) {
            link = next;
            break;
          }
          if (candidate === 0) {
            break;
          }
          candidate = this.fail[candidate]!;
        }
      }
      this.fail[node] = link;
      this.best[node] = terminal[node]! > 0 ? terminal[node]! : this.best[link]!;
    }
  }

  /** `null` when the secrets are too large to index (callers fail closed). */
  static create(secrets: Iterable<string>): SecretMatcher | null {
    const unique = [...new Set(secrets)].filter((secret) => secret.length > 0);
    let total = 0;
    for (const secret of unique) {
      total += secret.length;
      if (total > MAX_CROSS_REFERENCE_SECRET_CHARS) {
        return null;
      }
    }
    return unique.length === 0 ? null : new SecretMatcher(unique);
  }

  scrub(text: string): string {
    if (text.length < this.minLength) {
      return text;
    }
    let state = 0;
    let out = "";
    let last = 0;
    let intervalStart = -1;
    let intervalEnd = -1;
    for (let i = 0; i < text.length; i += 1) {
      const code = text.charCodeAt(i);
      for (;;) {
        const next = this.goto.get(state * 65536 + code);
        if (next !== undefined) {
          state = next;
          break;
        }
        if (state === 0) {
          break;
        }
        state = this.fail[state]!;
      }
      const length = this.best[state]!;
      if (length > 0) {
        const start = i + 1 - length;
        if (intervalStart >= 0 && start < intervalEnd) {
          intervalStart = Math.min(intervalStart, start);
          intervalEnd = i + 1;
        } else {
          if (intervalStart >= 0) {
            out += text.slice(last, intervalStart) + REDACTED_ENV_VALUE;
            last = intervalEnd;
          }
          intervalStart = start;
          intervalEnd = i + 1;
        }
      } else if (
        intervalStart >= 0 &&
        i + 2 - this.maxLength >= intervalEnd
      ) {
        // No later match can reach back into this interval any more.
        out += text.slice(last, intervalStart) + REDACTED_ENV_VALUE;
        last = intervalEnd;
        intervalStart = -1;
      }
    }
    if (intervalStart >= 0) {
      out += text.slice(last, intervalStart) + REDACTED_ENV_VALUE;
      last = intervalEnd;
    }
    return last === 0 && out === "" ? text : out + text.slice(last);
  }
}

function scrubKnownSecrets(text: string, matcher: SecretMatcher | null): string {
  return scrubSecretShapes(matcher ? matcher.scrub(text) : text);
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
  const matcher = SecretMatcher.create(secretValues);
  const failClosed = matcher === null && secretValues.length > 0;

  record.entries = entries.map((entry) => {
    if (!isRecord(entry)) {
      return entry;
    }
    const next: Record<string, unknown> = { ...entry };
    if (typeof entry.value === "string") {
      next.value =
        failClosed || (typeof entry.name === "string" && isSecretEnvName(entry.name))
          ? REDACTED_ENV_VALUE
          : scrubKnownSecrets(entry.value, matcher);
    }
    if (typeof entry.reason === "string") {
      next.reason = failClosed
        ? REDACTED_ENV_VALUE
        : scrubKnownSecrets(entry.reason, matcher);
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

/**
 * Named redaction policies (what each means is in the file header).
 * `wrapper` events carry one item whose own type picks the policy.
 */
export type CredentialPolicyName =
  | "diagnostic"
  | "tool"
  | "authored"
  | "wrapper";

const POLICIES: Record<
  Exclude<CredentialPolicyName, "wrapper">,
  CredentialRedactionPolicy
> = {
  diagnostic: { keys: "anywhere", text: "full" },
  tool: { keys: "containers", text: "tool" },
  authored: { keys: "containers", text: "none" },
};

/**
 * Policy of every thread event type. Typed over `ThreadEventType`, so adding
 * an event type fails to compile until it is classified here (and a test
 * checks the runtime union too).
 *
 * - diagnostic: errors, warnings, provider/system/lifecycle records and
 *   rejected-turn reasons: free text is operator/provider generated and can
 *   echo credentials.
 * - tool: tool/command/file output and progress.
 * - authored: prompts, assistant text, plans, reasoning, names, goals and
 *   structured records without free text: text is never scrubbed.
 * - wrapper: `item/started` / `item/completed` choose by `item.type`.
 */
export const EVENT_TYPE_POLICIES = {
  "thread/started": "authored",
  "thread/identity": "authored",
  "turn/started": "authored",
  "turn/completed": "diagnostic",
  "turn/input/accepted": "authored",
  "thread/name/updated": "authored",
  "thread/compacted": "authored",
  "thread/context/cleared": "authored",
  "thread/goal/updated": "authored",
  "thread/goal/cleared": "authored",
  "item/started": "wrapper",
  "item/completed": "wrapper",
  "item/agentMessage/delta": "authored",
  "item/commandExecution/outputDelta": "tool",
  "item/fileChange/outputDelta": "tool",
  "item/reasoning/summaryTextDelta": "authored",
  "item/reasoning/textDelta": "authored",
  "item/plan/delta": "authored",
  "item/mcpToolCall/progress": "tool",
  "item/toolCall/progress": "tool",
  "item/backgroundTask/progress": "tool",
  "item/backgroundTask/completed": "tool",
  "item/delegation/progress": "tool",
  "item/delegation/completed": "tool",
  "thread/tokenUsage/updated": "authored",
  "thread/contextWindowUsage/updated": "authored",
  "turn/plan/updated": "authored",
  "turn/diff/updated": "tool",
  "provider/error": "diagnostic",
  "provider/rateLimits/updated": "diagnostic",
  "provider.env-resolved": "diagnostic",
  "thread/extensionState/updated": "tool",
  "provider/warning": "diagnostic",
  "provider/modelFallback": "diagnostic",
  "provider/unhandled": "diagnostic",
  "client/thread/start": "diagnostic",
  "client/turn/requested": "authored",
  "client/turn/rejected": "diagnostic",
  "client/turn/start": "authored",
  "system/error": "diagnostic",
  "system/manager/user_message": "authored",
  "system/thread/interrupted": "diagnostic",
  "system/operation": "diagnostic",
  "system/interaction/lifecycle": "diagnostic",
  "system/permissionGrant/lifecycle": "diagnostic",
  "system/userQuestion/lifecycle": "diagnostic",
  "system/thread-provisioning": "diagnostic",
  "system/provider-turn-watchdog": "diagnostic",
} as const satisfies Record<ThreadEventType, CredentialPolicyName>;

/** Wrapped item types holding authored content; every other kind is a tool. */
const AUTHORED_ITEM_TYPES: ReadonlySet<string> = new Set([
  "userMessage",
  "agentMessage",
  "reasoning",
  "plan",
  "planSteps",
]);

function policyNameForType(type: string): CredentialPolicyName {
  const known = (EVENT_TYPE_POLICIES as Record<string, CredentialPolicyName>)[
    type
  ];
  // Own-property check: `type` is data and could be `constructor`.
  if (
    known !== undefined &&
    Object.prototype.hasOwnProperty.call(EVENT_TYPE_POLICIES, type)
  ) {
    return known;
  }
  // Unclassified (legacy or future) types fail toward scrubbing.
  return "tool";
}

/**
 * Which redaction rules apply to an event type. For `wrapper` types this is
 * the tool policy; use `policyForEvent` when the payload is at hand.
 */
export function policyForType(type: string): CredentialRedactionPolicy {
  const name = policyNameForType(type);
  return POLICIES[name === "wrapper" ? "tool" : name];
}

/** Like `policyForType`, picking the wrapped item's policy for wrappers. */
export function policyForEvent(
  type: string,
  data: unknown,
): CredentialRedactionPolicy {
  if (policyNameForType(type) !== "wrapper") {
    return policyForType(type);
  }
  const item = isRecord(data) ? data.item : undefined;
  const itemType = isRecord(item) ? item.type : undefined;
  return typeof itemType === "string" && AUTHORED_ITEM_TYPES.has(itemType)
    ? POLICIES.authored
    : POLICIES.tool;
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

/**
 * Replaces echoes of known secrets in every string. `frontier` tracks the
 * schema-structural positions (enums, discriminators, ids, ...) which are
 * never rewritten, so the event stays valid; `null` means no schema applies.
 * `matcher === null` fails closed: every non-structural string is replaced.
 */
function scrubKnownSecretsDeep(
  value: unknown,
  matcher: SecretMatcher | null,
  frontier: readonly StructuralNode[] | null,
  depth: number,
): unknown {
  if (typeof value === "string") {
    if (
      value === REDACTED_ENV_VALUE ||
      (frontier !== null && isStructuralTerminal(frontier))
    ) {
      return value;
    }
    return matcher === null ? REDACTED_ENV_VALUE : matcher.scrub(value);
  }
  if (
    typeof value !== "object" ||
    value === null ||
    depth > MAX_SANITIZE_DEPTH
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    const items =
      frontier === null ? null : stepStructural(frontier, STRUCTURAL_ARRAY_KEY);
    return value.map((item) =>
      scrubKnownSecretsDeep(item, matcher, items, depth + 1),
    );
  }
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    out[key] = scrubKnownSecretsDeep(
      child,
      matcher,
      frontier === null ? null : stepStructural(frontier, key),
      depth + 1,
    );
  }
  return out;
}

export interface SanitizeCredentialsOptions {
  /** `true` is the full diagnostic scrub, `false` none. */
  freeText: boolean | CredentialTextScrub;
  keys?: CredentialKeyScope;
  /** Top-level fields copied through untouched (full events only). */
  envelopeKeys?: ReadonlySet<string>;
  /** Payload follows thread event schemas: keep their control fields intact. */
  structural?: boolean;
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
    // Every collected secret is matched (no cap); a secret set too large to
    // index fails closed by replacing all non-structural strings.
    const matcher = SecretMatcher.create(state.secrets);
    result = scrubKnownSecretsDeep(
      result,
      matcher,
      options.structural ? [getStructuralRoot()] : null,
      0,
    );
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
  const policy = policyForEvent(type, data);
  return sanitizeCredentialsDeep(base, {
    freeText: policy.text,
    keys: policy.keys,
    structural: true,
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
