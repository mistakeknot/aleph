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
 *
 * What this does NOT catch (full text: docs/credential-redaction-residuals.md):
 * - secrets we do not hold, in a format with no vendored prefix and no
 *   recognised flag/assignment/header/JSON/URL context;
 * - split, truncated or oddly encoded echoes of a secret (a secret broken by
 *   quotes such as `prefix"x"SUFFIX`, cut in half, ANSI-C `$'..'`, `\xNN`,
 *   double encodings, anything shorter than 8 characters);
 * - the round-10 repro shapes when the secret is not known: quote
 *   continuation (`'prefix'SUFFIX`), marker-prefixed values
 *   (`TOKEN=[redacted]'SUFFIX'`), escaped delimiters (`prefix\ SUFFIX`) and
 *   quote-split URL userinfo with whitespace. With the secret known, only the
 *   quote-split forms (secret not literal in the text) stay open.
 * The shell-quoting heuristics are frozen by decision (mk-3aoo q181).
 */

import type { ThreadEventType } from "./provider-event.js";
import { expandSecretVariants } from "./secret-variants.js";
import {
  VENDOR_TOKEN_PRECHECK,
  scrubVendorTokens,
} from "./vendor-token-patterns.js";
import {
  STRUCTURAL_ARRAY_KEY,
  enterStructural,
  isStructuralTerminal,
  repairSchemaViolations,
  structuralFrontierAt,
  stepStructural,
  structuralFrontierForType,
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
  /(?<![a-z0-9+.-])([a-z][a-z0-9+.-]*:\/\/)[^\s/]+@/gi;
const BEARER_PATTERN = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi;
/** Tool text: only a bearer token that is clearly a credential, not prose. */
const STRONG_BEARER_PATTERN = /\b(Bearer)\s+[A-Za-z0-9._~+/=-]{16,}/gi;
/**
 * Names of credential headers: `Authorization:`, `Cookie:`, ... The value is
 * scanned in code (`scanHeaderValueEnd`) because it can contain quoted
 * segments, escaped quotes (embedded JSON text) and unterminated quotes.
 */
const SECRET_HEADER_NAME_PATTERN =
  /((?:^|[\s,;{(\\"'])(?:proxy-)?(?:authorization|cookie|set-cookie|x-api-key|x-auth-token|x-access-token)\s*:)([ \t]*)/gi;
/** Opening of an embedded JSON pair: `"apiKey":` / `\"apiKey\":` / `"apiKey":`. */
const JSON_KEY_PATTERN =
  /(?<!\\)(\\*"(?:[\w.-]|\\u[0-9a-fA-F]{4})+\\*"\s*:\s*)/g;
const JSON_STRING_PATTERN = /"(?:[^"\\]|\\.)*"/y;
const JSON_ESCAPED_QUOTE_PATTERN = /\\+"/y;
const JSON_SCALAR_VALUE_PATTERN = /[^\s,}\]]+/y;
/**
 * `--api-key X` / `--token X` (flag-style, space separated). The pattern only
 * finds the prefix; the value is a shell word scanned in code
 * (`scanSecretWordEnd`), because it can be quoted, hold escaped quotes and be
 * made of adjacent quoted fragments (`prefix'tail'`).
 */
const SECRET_FLAG_PATTERN = /(?<=^|[\s'"])(-{1,2}[\w.-]+\s+)(?!-)(?=[^\s&;,])/g;
/** `NAME=value`, `NAME: value`, `--flag="value"`, `KEY='value'`, `?sig=value`. */
const SECRET_ASSIGNMENT_PATTERN =
  /(?<=^|[\s?&;,'"({\[=])(-{0,2}[\w.-]+\s*[=:])(?!\s*\[redacted\](?![^\s&;,'"]))(\s*)(?=[^\s&;,])/g;

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
 * End index of the JSON value starting at `pos`. A string whose end cannot be
 * established (unterminated, or an escaped string with no closing quote) runs
 * to the end of the line.
 */
function findJsonValueEnd(text: string, pos: number, escaped: boolean): number {
  if (escaped) {
    JSON_ESCAPED_QUOTE_PATTERN.lastIndex = pos;
    const open = JSON_ESCAPED_QUOTE_PATTERN.exec(text);
    if (open === null) {
      return matchSticky(JSON_SCALAR_VALUE_PATTERN, text, pos);
    }
    return findEscapedQuoteEnd(
      text,
      pos + open[0].length,
      DOUBLE_QUOTE,
      open[0].length - 1,
    );
  }
  if (text.charCodeAt(pos) === DOUBLE_QUOTE) {
    const end = matchSticky(JSON_STRING_PATTERN, text, pos);
    return end < 0 ? findLineEnd(text, pos) : end;
  }
  return matchSticky(JSON_SCALAR_VALUE_PATTERN, text, pos);
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

function findLineEnd(text: string, from: number): number {
  let i = from;
  while (i < text.length && !isLineBreak(text.charCodeAt(i))) {
    i += 1;
  }
  return i;
}

/**
 * End of a plain quoted segment; the end of the line when unterminated. A
 * quote preceded by an odd number of backslashes is a quoted-pair inside the
 * value (`"a\"b"`), not the end of the segment.
 */
function findPlainQuoteEnd(text: string, from: number, quote: number): number {
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
    if (code === quote && backslashes % 2 === 0) {
      return i + 1;
    }
    backslashes = 0;
  }
  return text.length;
}

/**
 * End of an escaped quoted segment (`\"...\"` inside embedded JSON text).
 * `openBackslashes` is the serialization depth of the opening quote: the
 * closing quote carries the same number of backslashes, while a quoted-pair
 * inside the value (`\\\"`) carries more and does not end the segment. A quote
 * with fewer backslashes (a bare quote closing the surrounding JSON string) or
 * the end of the line ends an unterminated segment and is left alone.
 */
function findEscapedQuoteEnd(
  text: string,
  from: number,
  quote: number,
  openBackslashes: number,
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
      if (backslashes === openBackslashes) {
        return i + 1;
      }
      if (backslashes < openBackslashes) {
        return i - backslashes;
      }
    }
    backslashes = 0;
  }
  return text.length;
}

/** The quote that opens the string a header sits in (`depth` = its backslashes). */
interface HeaderOpener {
  quote: number;
  depth: number;
}

/**
 * End of a header value starting at `start`: to the end of the line, except
 * that a quote which does not open a quoted segment (right after `=` or at
 * the start of the value) may end it as the closing quote of the surrounding
 * string or shell quoting, but only a quote that matches `opener`, the quote
 * that opens that surrounding string: same kind and at most as many
 * backslashes. Any other quote (an escaped quote inside an unquoted value,
 * `prefix\"tail`) is value content, and with no known opener everything to
 * the end of the line is. Unterminated quoted segments run to the end of the
 * line.
 */
function scanHeaderValueEnd(
  text: string,
  start: number,
  opener: HeaderOpener | null,
): number {
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
        if (opensSegment) {
          i = findEscapedQuoteEnd(text, j + 1, next, j - i);
          opensSegment = false;
          continue;
        }
        if (opener !== null && next === opener.quote && j - i <= opener.depth) {
          break;
        }
        i = j + 1;
        continue;
      }
      i = j;
      opensSegment = false;
      continue;
    }
    if (code === DOUBLE_QUOTE || code === SINGLE_QUOTE) {
      if (opensSegment) {
        i = findPlainQuoteEnd(text, i + 1, code);
        opensSegment = false;
        continue;
      }
      if (opener !== null && code === opener.quote && opener.depth >= 0) {
        break;
      }
      i += 1;
      continue;
    }
    opensSegment =
      code === EQUALS || (opensSegment && (code === 32 || code === 9));
    i += 1;
  }
  return i;
}

/** ASCII alphanumerics, `_` and every non-ASCII code unit (conservatively). */
function isWordCode(code: number): boolean {
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    code === 95 ||
    (code >= 97 && code <= 122) ||
    code >= 128
  );
}

/**
 * Which quote is open at a scan position on the current line, i.e. the one
 * that opens the string a secret sits in (`opener` is null when none is open:
 * a quote that was opened and closed earlier says nothing about the secret).
 * Advanced monotonically (linear).
 *
 * A quote was seen word-adjacent with no string open on this line (`x"!"`,
 * `5"`, `-H"`, `users'`). Such a quote may open a string (shell concatenation)
 * or not, so whether any later quote opens or closes one is unknown: no quote
 * is trusted to enclose a secret for the rest of the line (`doubtful`), and the
 * value runs to the end of the line (fail closed).
 */
class QuoteTracker {
  opener: HeaderOpener | null = null;
  private doubtful = false;
  private scanned = 0;

  advanceTo(text: string, position: number): void {
    while (this.scanned < position) {
      const code = text.charCodeAt(this.scanned);
      if (isLineBreak(code)) {
        this.opener = null;
        this.doubtful = false;
      } else if (code === DOUBLE_QUOTE || code === SINGLE_QUOTE) {
        let depth = 0;
        for (
          let k = this.scanned - 1;
          k >= 0 && text.charCodeAt(k) === BACKSLASH;
          k -= 1
        ) {
          depth += 1;
        }
        const wordBefore = isWordCode(
          this.scanned > depth ? text.charCodeAt(this.scanned - depth - 1) : -1,
        );
        if (this.opener === null) {
          if (wordBefore) {
            // No contraction exception: `it's` and `x's!'` look alike.
            this.doubtful = true;
          } else if (!this.doubtful) {
            this.opener = { quote: code, depth };
          }
        } else if (code === this.opener.quote && depth <= this.opener.depth) {
          // Closes the open string (fewer backslashes: it ended earlier).
          this.opener = null;
        }
      }
      this.scanned += 1;
    }
  }
}

function scrubSecretHeaders(text: string): string {
  const pattern = SECRET_HEADER_NAME_PATTERN;
  pattern.lastIndex = 0;
  let out = "";
  let last = 0;
  const quotes = new QuoteTracker();
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    quotes.advanceTo(
      text,
      match.index + (/^[\s,;{(\\"']/.test(match[0]) ? 1 : 0),
    );
    const valueStart = match.index + match[0].length;
    const valueEnd = scanHeaderValueEnd(text, valueStart, quotes.opener);
    if (valueEnd === valueStart) {
      continue;
    }
    out += text.slice(last, valueStart) + REDACTED_ENV_VALUE;
    last = valueEnd;
    pattern.lastIndex = valueEnd;
  }
  pattern.lastIndex = 0;
  return out + text.slice(last);
}

function isWordBreakCode(code: number, char: string): boolean {
  return (
    code === 38 || // &
    code === 59 || // ;
    code === 44 || // ,
    (code <= 32
      ? code === 32 || (code >= 9 && code <= 13)
      : code >= 160 && /\s/.test(char))
  );
}

/**
 * End of a secret flag/assignment/bearer value starting at `start`: the shell
 * word it belongs to, i.e. everything up to unquoted whitespace, `&`, `;` or
 * `,`, where every quoted fragment is part of the word (`prefix'tail'`,
 * `"a"'b'`, `"a\"b"`). Same fail-closed rule as headers: a quote that is not
 * the start of the value may close the string the secret sits in only when it
 * matches `opener`; any other quote opens a further fragment of the value, and
 * a fragment whose end cannot be found runs to the end of its line. A quote
 * that opens the value itself may span lines when it is closed later.
 *
 * `noClose` remembers quote kinds with no closing quote left in the text, so
 * unterminated quotes cost one scan to the end of the text in total.
 */
function scanSecretWordEnd(
  text: string,
  start: number,
  opener: HeaderOpener | null,
  opensSegment: boolean,
  noClose: Set<number>,
): number {
  let i = start;
  const atValueStart = opensSegment ? start : -1;
  while (i < text.length) {
    const code = text.charCodeAt(i);
    if (isWordBreakCode(code, text[i] ?? "")) {
      break;
    }
    if (code === BACKSLASH) {
      let j = i;
      while (j < text.length && text.charCodeAt(j) === BACKSLASH) {
        j += 1;
      }
      const next = j < text.length ? text.charCodeAt(j) : -1;
      if (next === DOUBLE_QUOTE || next === SINGLE_QUOTE) {
        if (
          !opensSegment &&
          opener !== null &&
          next === opener.quote &&
          j - i <= opener.depth
        ) {
          break;
        }
        i = findEscapedQuoteEnd(text, j + 1, next, j - i);
      } else {
        i = j;
      }
      opensSegment = false;
      continue;
    }
    if (code === DOUBLE_QUOTE || code === SINGLE_QUOTE) {
      if (
        !opensSegment &&
        opener !== null &&
        code === opener.quote &&
        opener.depth >= 0
      ) {
        break;
      }
      i =
        i === atValueStart
          ? findOpeningQuoteEnd(text, i + 1, code, noClose)
          : findPlainQuoteEnd(text, i + 1, code);
      opensSegment = false;
      continue;
    }
    opensSegment = code === EQUALS;
    i += 1;
  }
  return i;
}

/** Closing quote of a value-opening quote, possibly on a later line. */
function findOpeningQuoteEnd(
  text: string,
  from: number,
  quote: number,
  noClose: Set<number>,
): number {
  if (!noClose.has(quote)) {
    let backslashes = 0;
    for (let i = from; i < text.length; i += 1) {
      const code = text.charCodeAt(i);
      if (code === BACKSLASH) {
        backslashes += 1;
        continue;
      }
      if (code === quote && backslashes % 2 === 0) {
        return i + 1;
      }
      backslashes = 0;
    }
    noClose.add(quote);
  }
  return findLineEnd(text, from);
}

/**
 * Replaces the value of every secret-named match of `pattern` (which matches
 * the prefix up to the value) with the redaction marker. `isSecret` is checked
 * first so non-secret names never cost a value scan; they resume scanning
 * right after the prefix so nested matches are still found.
 */
function scrubSecretWords(
  text: string,
  pattern: RegExp,
  isSecret: (match: RegExpExecArray) => boolean,
  render: (match: RegExpExecArray) => string,
): string {
  pattern.lastIndex = 0;
  let out = "";
  let last = 0;
  const quotes = new QuoteTracker();
  const noClose = new Set<number>();
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    if (!isSecret(match)) {
      pattern.lastIndex = match.index + Math.max(1, match[1]?.length ?? 1);
      continue;
    }
    quotes.advanceTo(text, match.index);
    const valueStart = match.index + match[0].length;
    const valueEnd = scanSecretWordEnd(
      text,
      valueStart,
      quotes.opener,
      true,
      noClose,
    );
    out += text.slice(last, match.index) + render(match);
    last = valueEnd;
    pattern.lastIndex = valueEnd;
  }
  pattern.lastIndex = 0;
  return out + text.slice(last);
}

/**
 * `Bearer`/`Basic` followed by token characters. A quote right after those
 * characters is not part of the token alphabet but may belong to the credential
 * (`Bearer prefix'tail'`), so the same word scan decides how far it goes.
 */
function scrubBearerText(text: string, pattern: RegExp): string {
  pattern.lastIndex = 0;
  let out = "";
  let last = 0;
  const quotes = new QuoteTracker();
  const noClose = new Set<number>();
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    let end = match.index + match[0].length;
    const next = text.charCodeAt(end);
    if (next === DOUBLE_QUOTE || next === SINGLE_QUOTE || next === BACKSLASH) {
      quotes.advanceTo(text, match.index);
      end = scanSecretWordEnd(text, end, quotes.opener, false, noClose);
    }
    out += text.slice(last, match.index) + `${match[1]} ${REDACTED_ENV_VALUE}`;
    last = end;
    pattern.lastIndex = end;
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
  return scrubBearerText(
    scrubVendorTokens(scrubSecretHeaders(text), REDACTED_ENV_VALUE).replace(
      URL_USERINFO_PATTERN,
      `$1${REDACTED_ENV_VALUE}@`,
    ),
    STRONG_BEARER_PATTERN,
  );
}

/** `?key=` / `&key=` / `#key=` / `;key=`: the start of a URL parameter. */
const URL_PARAM_START_PATTERN = /[?&#;]([^=&#;\s"'<>]{1,200})=/g;

/** Nested (percent-encoded) URLs are decoded this many levels deep. */
const MAX_URL_PARAM_NESTING = 3;

/**
 * Percent-decodes every well-formed escape and leaves anything else literal
 * (a malformed escape or invalid UTF-8 never blocks decoding the rest), in
 * one linear pass. The result is never longer than the input.
 */
function decodeUrlComponent(raw: string): string {
  if (!raw.includes("%")) {
    return raw;
  }
  return raw.replace(/(?:%[0-9a-fA-F]{2})+/g, (run) => {
    try {
      return decodeURIComponent(run);
    } catch {
      const bytes = new Uint8Array(run.length / 3);
      for (let i = 0; i < bytes.length; i += 1) {
        bytes[i] = Number.parseInt(run.slice(i * 3 + 1, i * 3 + 3), 16);
      }
      return new TextDecoder().decode(bytes);
    }
  });
}

/**
 * Masks the value of every credential parameter in text that is a URL field.
 * Inside a URL field a value runs to the next `&`: quotes, whitespace, `<`,
 * `>`, `;` and `#` are all legal value content (an apostrophe is common in
 * query strings), so none of them ends a credential, and masking more than
 * the credential only loses unrelated parameters after it. A parameter whose
 * percent-decoded value itself holds a credential parameter (a nested
 * `next=https%3A%2F%2F...%3Ftoken%3D...` URL) is masked whole. Scanning
 * continues inside non-credential values, so a `;` or `?` separated
 * credential after them is still found.
 *
 * Linear time: the text is cut into `&` segments, each looked at once. The
 * nested check decodes and rescans only the tail of a segment from its first
 * non-credential parameter, once per segment (every later parameter's value
 * is a suffix of it, and decoding is per escape, so nothing a later start
 * would find is lost). Segments are disjoint and a decoded tail is never
 * longer than its source, so each nesting level costs at most one pass over
 * the text and the total is bounded by `MAX_URL_PARAM_NESTING + 1` passes.
 */
function scrubUrlParams(text: string, nesting = 0): string {
  let out = "";
  let last = 0;
  let segmentEnd = -1; // end of the `&` segment being scanned
  let segmentChecked = false; // nested check done for this segment
  for (const match of text.matchAll(URL_PARAM_START_PATTERN)) {
    if (match.index < last) {
      continue; // inside a value that was already masked
    }
    const valueStart = match.index + match[0].length;
    if (match.index >= segmentEnd) {
      segmentEnd = text.indexOf("&", valueStart);
      if (segmentEnd < 0) {
        segmentEnd = text.length;
      }
      segmentChecked = false;
    }
    if (
      segmentEnd - valueStart === REDACTED_ENV_VALUE.length &&
      text.startsWith(REDACTED_ENV_VALUE, valueStart)
    ) {
      continue;
    }
    let secret = isSecretTextKey(decodeUrlComponent(match[1] ?? ""));
    if (!secret && !segmentChecked && nesting < MAX_URL_PARAM_NESTING) {
      segmentChecked = true;
      const value = text.slice(valueStart, segmentEnd);
      if (value.includes("%")) {
        const decoded = decodeUrlComponent(value);
        secret =
          decoded !== value && scrubUrlParams(decoded, nesting + 1) !== decoded;
      }
    }
    if (secret) {
      out += text.slice(last, valueStart) + REDACTED_ENV_VALUE;
      last = segmentEnd;
    }
  }
  return out + text.slice(last);
}

/** `scrubToolText` plus credential parameters of a URL's query/fragment. */
function scrubUrlText(text: string): string {
  return scrubUrlParams(scrubToolText(text));
}

function scrubSecretShapes(text: string): string {
  return scrubSecretWords(
    scrubSecretWords(
      scrubBearerText(
        scrubJsonSecretPairs(
          scrubVendorTokens(scrubSecretHeaders(text), REDACTED_ENV_VALUE),
        ).replace(URL_USERINFO_PATTERN, `$1${REDACTED_ENV_VALUE}@`),
        BEARER_PATTERN,
      ),
      SECRET_FLAG_PATTERN,
      (m) => isSecretTextKey(m[1] ?? ""),
      (m) => `${m[1]}${REDACTED_ENV_VALUE}`,
    ),
    SECRET_ASSIGNMENT_PATTERN,
    (m) => isSecretTextKey((m[1] ?? "").replace(/\s*[=:]$/, "")),
    (m) => `${m[1]}${m[2]}${REDACTED_ENV_VALUE}`,
  );
}

/**
 * Ceiling on the characters indexed by one matcher (every secret plus all of
 * its encoded variants, see `expandSecretVariants`). Beyond it, or when one
 * secret is too long to expand, `SecretMatcher.create` returns `null` and
 * callers fail closed. Memory is bounded by this constant.
 */
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
      this.best[node] =
        terminal[node]! > 0 ? terminal[node]! : this.best[link]!;
    }
  }

  /**
   * Indexes every secret and its encoded variants. `null` when the secrets
   * are too large to index (callers fail closed) or none are given.
   */
  static create(secrets: Iterable<string>): SecretMatcher | null {
    const unique = [...new Set(secrets)].filter((secret) => secret.length > 0);
    const patterns = new Set<string>();
    let total = 0;
    for (const secret of unique) {
      // Cheap pre-check before expanding: raw characters alone are bounded.
      total += secret.length;
      if (total > MAX_CROSS_REFERENCE_SECRET_CHARS) {
        return null;
      }
      const variants = expandSecretVariants(secret);
      if (variants === null) {
        return null;
      }
      for (const variant of variants) {
        if (!patterns.has(variant)) {
          patterns.add(variant);
          total += variant.length;
        }
      }
      if (total > MAX_CROSS_REFERENCE_SECRET_CHARS) {
        return null;
      }
    }
    return patterns.size === 0 ? null : new SecretMatcher([...patterns]);
  }

  scrub(text: string): string {
    if (text.length < this.minLength) {
      return text;
    }
    // Pass 1: the union of every match, as disjoint intervals. A later (longer)
    // match can reach back across earlier ones, so nothing is rendered until
    // the whole text has been scanned; the stack merges backwards in
    // amortized constant time.
    const starts: number[] = [];
    const ends: number[] = [];
    let state = 0;
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
      if (length === 0) {
        continue;
      }
      let start = i + 1 - length;
      while (ends.length > 0 && ends[ends.length - 1]! > start) {
        start = Math.min(start, starts[starts.length - 1]!);
        starts.pop();
        ends.pop();
      }
      starts.push(start);
      ends.push(i + 1);
    }
    if (starts.length === 0) {
      return text;
    }
    // Pass 2: render.
    let out = "";
    let last = 0;
    for (let k = 0; k < starts.length; k += 1) {
      out += text.slice(last, starts[k]) + REDACTED_ENV_VALUE;
      last = ends[k]!;
    }
    return out + text.slice(last);
  }
}

function scrubKnownSecrets(
  text: string,
  matcher: SecretMatcher | null,
): string {
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
        failClosed ||
        (typeof entry.name === "string" && isSecretEnvName(entry.name))
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
export type CredentialTextScrub = "full" | "fullUrl" | "tool" | "url" | "none";

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

/** A URL field: tool scrub plus credential query/fragment parameters. */
const URL_POLICY: CredentialRedactionPolicy = {
  keys: "containers",
  text: "url",
};

/** A URL field inside diagnostics: the full scrub plus URL parameters. */
const URL_FULL_POLICY: CredentialRedactionPolicy = {
  keys: "anywhere",
  text: "fullUrl",
};

/** Whether a payload key (or the key of an array of values) names a URL. */
function isUrlFieldPath(path: readonly string[]): boolean {
  let last = path[path.length - 1];
  if (last === STRUCTURAL_ARRAY_KEY_SEGMENT && path.length > 1) {
    last = path[path.length - 2];
  }
  return last !== undefined && URL_FIELD_KEY_PATTERN.test(normalizeKey(last));
}

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

const STRUCTURAL_ARRAY_KEY_SEGMENT = "*";
const URL_FIELD_KEY_PATTERN = /(url|uri|href)s?$/;

const TURN_PARAMS_TYPES: ReadonlySet<string> = new Set([
  "client/turn/start",
  "client/turn/requested",
]);

/** Item-carrying events outside the `wrapper` types. */
const ITEM_EVENT_TYPES: ReadonlySet<string> = new Set([
  "item/backgroundTask/progress",
  "item/backgroundTask/completed",
  "item/delegation/progress",
  "item/delegation/completed",
  "item/mcpToolCall/progress",
  "item/toolCall/progress",
]);

/**
 * Subtree overrides for whole-type policies that are wrong for some fields:
 * - turn requests: `request.params` is a free-form provider call; only real
 *   prompt text (`input[*].text` of a text part) is authored. An image `url`
 *   may carry a credential in its query (`input`, `inputGroups`, and the
 *   copy under `request.params`).
 * - item events: an item's `error` (and a workflow agent's, nested in a
 *   background-task snapshot) is provider diagnostics, and an image/fetch
 *   `url` may carry a credential in its query (unlike prompt text).
 */
function ruleForType(type: string): CredentialPolicyRule | null {
  if (TURN_PARAMS_TYPES.has(type)) {
    return (path, parent) => {
      // A URL field at any depth (`input`, `inputGroups`, and any copy or
      // nesting under the free-form `request.params`) may carry a credential
      // in its query. Authored prompt text is not a URL field.
      if (isUrlFieldPath(path)) {
        return path[0] === "request" && path[1] === "params"
          ? URL_FULL_POLICY
          : URL_POLICY;
      }
      if (path.length === 2 && path[0] === "request" && path[1] === "params") {
        return POLICIES.diagnostic;
      }
      if (
        path.length === 5 &&
        path[0] === "request" &&
        path[1] === "params" &&
        path[2] === "input" &&
        path[3] === "*" &&
        path[4] === "text" &&
        parent?.type === "text"
      ) {
        return POLICIES.authored;
      }
      return null;
    };
  }
  if (policyNameForType(type) === "wrapper" || ITEM_EVENT_TYPES.has(type)) {
    return (path) => {
      if (path[0] !== "item") {
        return null;
      }
      if (path.length === 2 && path[1] === "error") {
        return POLICIES.diagnostic;
      }
      if (
        path.length === 5 &&
        path[1] === "workflow" &&
        path[2] === "agents" &&
        path[3] === "*" &&
        path[4] === "error"
      ) {
        return POLICIES.diagnostic;
      }
      // A URL field at any depth (image `content`, a fetch `url`, nested
      // results) may carry a credential in its query; inside a diagnostic
      // subtree it keeps the full scrub as well.
      if (isUrlFieldPath(path)) {
        return path[1] === "error" || path[1] === "workflow"
          ? URL_FULL_POLICY
          : URL_POLICY;
      }
      return null;
    };
  }
  return null;
}

function hasUrlFieldRule(type: string): boolean {
  return ruleForType(type) !== null;
}

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

/**
 * Overrides the policy for one subtree. Called when the walk enters a child
 * (`path` includes it; array indices are `*`), with the child's parent.
 */
export type CredentialPolicyRule = (
  path: readonly string[],
  parent: Record<string, unknown> | null,
) => CredentialRedactionPolicy | null;

interface SanitizeState {
  keys: CredentialKeyScope;
  text: CredentialTextScrub;
  envelopeKeys: ReadonlySet<string> | null;
  changed: boolean;
  secrets: Set<string>;
  rule: CredentialPolicyRule | null;
  path: string[];
}

/** Walks one child, applying a policy override for its subtree if a rule has one. */
function walkChild(
  state: SanitizeState,
  segment: string,
  parent: Record<string, unknown> | null,
  walk: () => unknown,
): unknown {
  if (state.rule === null) {
    return walk();
  }
  state.path.push(segment);
  const override = state.rule(state.path, parent);
  let result: unknown;
  if (override === null) {
    result = walk();
  } else {
    const { keys, text } = state;
    state.keys = override.keys;
    state.text = override.text;
    result = walk();
    state.keys = keys;
    state.text = text;
  }
  state.path.pop();
  return result;
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
    state.text === "full"
      ? scrubSecretShapes(value)
      : state.text === "fullUrl"
        ? scrubUrlParams(scrubSecretShapes(value))
        : state.text === "url"
          ? scrubUrlText(value)
          : scrubToolText(value);
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
      walkChild(state, STRUCTURAL_ARRAY_KEY, null, () =>
        walkSanitize(
          item,
          state,
          depth + 1,
          mode === "force" ? "force" : "plain",
        ),
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
    next[key] = walkChild(state, key, record, () =>
      walkSanitize(child, state, depth + 1, childMode),
    );
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
  const entered = frontier === null ? null : enterStructural(frontier, value);
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    out[key] = scrubKnownSecretsDeep(
      child,
      matcher,
      entered === null ? null : stepStructural(entered, key),
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
  /**
   * Payload of an event of this type: keep the control fields its schema
   * constrains intact, and keep the result schema-valid (full events carry
   * their own `type`, data-only payloads do not).
   */
  structural?: { type: string; fullEvent: boolean };
  /** Per-subtree policy overrides (see `CredentialPolicyRule`). */
  rule?: CredentialPolicyRule;
  /**
   * The payload before any earlier redaction step produced `value` (the
   * env-resolved base): schema repair compares against it, not against the
   * already-redacted `value`.
   */
  original?: unknown;
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
    rule: options.rule ?? null,
    path: [],
  };
  let result = walkSanitize(value, state, 0, "plain");
  if (state.secrets.size > 0) {
    // Every collected secret is matched (no cap); a secret set too large to
    // index fails closed by replacing all non-structural strings.
    const matcher = SecretMatcher.create(state.secrets);
    const frontier = options.structural
      ? structuralFrontierForType(options.structural.type)
      : null;
    // Match echoes (and their encoded variants) in the ORIGINAL text first:
    // the shape scrubbers below may rewrite part of a word and break the
    // literal match. `state.changed` is already set by the first walk.
    result = walkSanitize(
      scrubKnownSecretsDeep(value, matcher, frontier, 0),
      state,
      0,
      "plain",
    );
    result = scrubKnownSecretsDeep(result, matcher, frontier, 0);
    if (state.envelopeKeys !== null && isRecord(value) && isRecord(result)) {
      for (const key of state.envelopeKeys) {
        if (key in value) {
          result[key] = value[key];
        }
      }
    }
  }
  const original = options.original === undefined ? value : options.original;
  if (!state.changed && original === value) {
    return value;
  }
  if (options.structural && isRecord(result)) {
    const { type, fullEvent } = options.structural;
    const maskAt = (root: unknown, path: readonly PropertyKey[]): unknown => {
      let subtree = root;
      for (const key of path) {
        subtree = isContainer(subtree)
          ? (subtree as Record<PropertyKey, unknown>)[key]
          : undefined;
      }
      const masked = scrubKnownSecretsDeep(
        subtree,
        null,
        structuralFrontierAt(type, root, path),
        0,
      );
      if (path.length === 0 && isRecord(masked) && isRecord(original)) {
        for (const key of state.envelopeKeys ?? []) {
          if (key in original) {
            masked[key] = original[key];
          }
        }
      }
      return masked;
    };
    return repairSchemaViolations(
      type,
      original,
      result,
      fullEvent,
      maskAt,
    ) as T;
  }
  return result as T;
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
  const rule = ruleForType(type);
  return sanitizeCredentialsDeep(base, {
    original: data,
    freeText: policy.text,
    keys: policy.keys,
    structural: { type, fullEvent: envelopeKeys !== null },
    ...(rule ? { rule } : {}),
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
  // Types with URL field overrides also parse when the text has a `=`: a
  // signed URL (`?sig=...`) needs no credential-looking word or `://`.
  if (
    policyForType(type).keys === "containers" &&
    !JSON_PRECHECK_PATTERN.test(json) &&
    !VENDOR_TOKEN_PRECHECK.test(json) &&
    !(hasUrlFieldRule(type) && json.includes("="))
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
