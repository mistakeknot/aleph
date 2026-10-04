/**
 * Encoded forms of a known secret.
 *
 * A secret the process holds can be echoed in text after a transform: URL
 * query or userinfo encoding, base64 in an `Authorization: Basic` blob or a
 * JWT-ish field, JSON escaping inside a serialized string, shell escaping in
 * a logged command line, or hex in a debug dump. `expandSecretVariants`
 * returns the literal strings the Aho-Corasick matcher should look for, so
 * those echoes are found by exact match (no shell parsing, no heuristics).
 *
 * The expansion is a fixed set of transforms: at most `MAX_VARIANTS_PER_SECRET`
 * strings per secret, each at most `MAX_VARIANT_EXPANSION` times the secret's
 * length, and secrets longer than `MAX_EXPANDABLE_SECRET_CHARS` are not
 * expanded at all (the caller fails closed). Pure and deterministic.
 */

/** Secrets shorter than this are not expanded (same floor as registration). */
export const MIN_EXPANDED_SECRET_LENGTH = 8;

/** Longer secrets are refused by the caller (fail closed), not truncated. */
export const MAX_EXPANDABLE_SECRET_CHARS = 64 * 1024;

/** Hard ceiling on strings returned per secret (the transforms give <= 22). */
export const MAX_VARIANTS_PER_SECRET = 32;

/** Worst case total variant length relative to the secret (JSON twice, ...). */
export const MAX_VARIANT_EXPANSION = 64;

const B64_STANDARD =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_URL =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** Leading characters of an encoding that also depend on preceding bytes. */
const ALIGNMENT_LEAD = [0, 2, 3] as const;

function base64(bytes: Uint8Array, alphabet: string): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!;
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    out += alphabet[a >> 2]!;
    out += alphabet[((a & 3) << 4) | ((b ?? 0) >> 4)]!;
    if (b !== undefined) {
      out += alphabet[((b & 15) << 2) | ((c ?? 0) >> 6)]!;
    }
    if (c !== undefined) {
      out += alphabet[c & 63]!;
    }
  }
  return out;
}

/** Unpadded base64 of the secret at byte alignment 0, 1 or 2 inside a text. */
function base64Aligned(
  bytes: Uint8Array,
  alphabet: string,
  alignment: 0 | 1 | 2,
): string {
  const shifted = new Uint8Array(alignment + bytes.length);
  shifted.set(bytes, alignment);
  const encoded = base64(shifted, alphabet);
  // Characters that mix in bytes outside the secret are not stable: the lead
  // (neighbour bytes before) and the last character (neighbour bytes after).
  const end = shifted.length % 3 === 0 ? encoded.length : encoded.length - 1;
  return encoded.slice(ALIGNMENT_LEAD[alignment], end);
}

function hex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) {
    out += (byte < 16 ? "0" : "") + byte.toString(16);
  }
  return out;
}

function jsonEscaped(text: string): string {
  return JSON.stringify(text).slice(1, -1);
}

function percentAllBytes(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) {
    out += "%" + (byte < 16 ? "0" : "") + byte.toString(16).toUpperCase();
  }
  return out;
}

/** Backslash-escapes like bash `printf %q` (comma included). */
function shellBackslashEscaped(text: string): string {
  return text.replace(/[^A-Za-z0-9_@%+=:./-]/g, "\\$&");
}

/** Backslash before every character that is not a letter or digit. */
function shellBackslashAllPunctuation(text: string): string {
  return text.replace(/[^A-Za-z0-9]/g, "\\$&");
}

/** Contents of a single-quoted word: `'` becomes `'\''`. */
function shellSingleQuoted(text: string): string {
  return text.replace(/'/g, "'\\''");
}

/** Contents of a double-quoted word: `\`, `"`, `$` and backtick escaped. */
function shellDoubleQuoted(text: string): string {
  return text.replace(/[\\"$`]/g, "\\$&");
}

/**
 * `null` when the secret is too long to expand (callers fail closed);
 * otherwise the secret itself plus its distinct encoded forms.
 */
export function expandSecretVariants(secret: string): string[] | null {
  if (secret.length > MAX_EXPANDABLE_SECRET_CHARS) {
    return null;
  }
  if (secret.length < MIN_EXPANDED_SECRET_LENGTH) {
    return [secret];
  }
  const bytes = new TextEncoder().encode(secret);
  const out = new Set<string>([secret]);
  const add = (variant: string): void => {
    if (variant.length >= MIN_EXPANDED_SECRET_LENGTH) {
      out.add(variant);
    }
  };

  // URL: component encoding, form encoding (+), lowercase escapes, all bytes.
  const component = encodeURIComponent(secret);
  add(component);
  add(component.replace(/%20/g, "+"));
  add(component.replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase()));
  add(percentAllBytes(bytes));

  // base64: standard and URL-safe, any alignment, plus the padded whole form.
  for (const alphabet of [B64_STANDARD, B64_URL]) {
    for (const alignment of [0, 1, 2] as const) {
      add(base64Aligned(bytes, alphabet, alignment));
    }
    const whole = base64(bytes, alphabet);
    add(whole + "=".repeat((3 - (bytes.length % 3)) % 3));
  }

  // JSON: once, twice (JSON inside a JSON string), and ASCII-only \uXXXX.
  const json = jsonEscaped(secret);
  add(json);
  add(jsonEscaped(json));
  add(
    secret.replace(
      /[^\x20-\x7e]/g,
      (ch) => "\\u" + ch.charCodeAt(0).toString(16).padStart(4, "0"),
    ),
  );

  // Shell: backslash escapes and the contents of '...' and "..." words.
  add(shellBackslashEscaped(secret));
  add(shellBackslashAllPunctuation(secret));
  add(shellSingleQuoted(secret));
  add(shellDoubleQuoted(secret));

  // Hex dump of the UTF-8 bytes.
  const lower = hex(bytes);
  add(lower);
  add(lower.toUpperCase());

  return [...out].slice(0, MAX_VARIANTS_PER_SECRET);
}
