/**
 * Prefixed vendor credential formats, for secrets this process does NOT hold
 * (so the known-secret matcher cannot find them). High precision only: each
 * rule needs a fixed literal prefix or fixed structure. There is no entropy
 * scanning and no keyword-only rule.
 *
 * Adapted from the gitleaks default rules (config/gitleaks.toml).
 *   Source:  https://github.com/gitleaks/gitleaks
 *   Commit:  b58d3f102cf3a2c84cb7f923d05c25c9b1aed84b (2026-07-22)
 *   Licence: MIT, Copyright (c) 2019 Zachary Rice
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of the gitleaks software and associated documentation files (the
 * "Software"), to deal in the Software without restriction, including without
 * limitation the rights to use, copy, modify, merge, publish, distribute,
 * sublicense, and/or sell copies of the Software, subject to the following
 * conditions: the above copyright notice and this permission notice shall be
 * included in all copies or substantial portions of the Software. THE
 * SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
 * FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
 * DEALINGS IN THE SOFTWARE.
 *
 * Changes from gitleaks: translated from Go regexps to JavaScript; the
 * trailing delimiter group is dropped (the whole token is replaced, and a
 * longer-than-expected tail is consumed with `*`); the `(?i)` flag becomes an
 * explicit character class. Not from gitleaks: the Tailscale rule (gitleaks
 * has none; the key format is Tailscale's documented `tskey-` prefix).
 *
 * Linearity: no nested quantifiers and no alternation under a quantifier. Each
 * variable part is a fixed `{n}` minimum followed by a single character class
 * `*`, so a failed attempt at one start costs at most `n` steps (a constant)
 * and a successful one consumes its own run; the scan is linear. The private
 * key body is capped. `expectLinear` in the tests times adversarial inputs.
 */

export interface VendorTokenPattern {
  id: string;
  pattern: RegExp;
}

// A token is not a token when it is the tail of a longer word.
const B = "(?<![A-Za-z0-9])";

export const VENDOR_TOKEN_PATTERNS: readonly VendorTokenPattern[] = [
  { id: "github-pat", pattern: /ghp_[0-9a-zA-Z]{36}[0-9a-zA-Z]*/g },
  { id: "github-oauth", pattern: /gho_[0-9a-zA-Z]{36}[0-9a-zA-Z]*/g },
  { id: "github-app", pattern: /gh[us]_[0-9a-zA-Z]{36}[0-9a-zA-Z]*/g },
  { id: "github-refresh", pattern: /ghr_[0-9a-zA-Z]{36}[0-9a-zA-Z]*/g },
  { id: "github-fine-grained", pattern: /github_pat_\w{82}\w*/g },
  {
    id: "anthropic",
    pattern: /sk-ant-(?:api|admin)\d{2}-[A-Za-z0-9_-]{80}[A-Za-z0-9_-]*/g,
  },
  {
    id: "openai-project",
    pattern:
      /sk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{58}[A-Za-z0-9_-]{0,16}T3BlbkFJ[A-Za-z0-9_-]{58}[A-Za-z0-9_-]*/g,
  },
  {
    id: "openai-legacy",
    pattern: /sk-[a-zA-Z0-9]{20}T3BlbkFJ[a-zA-Z0-9]{20}/g,
  },
  {
    id: "slack-bot",
    pattern: /xoxb-[0-9]{10,13}-[0-9]{10,13}[a-zA-Z0-9-]*/g,
  },
  {
    id: "slack-user",
    pattern: /xox[pe](?:-[0-9]{10,13}){3}-[a-zA-Z0-9-]{28,34}/g,
  },
  {
    id: "slack-legacy",
    pattern: /xox[os]-\d{1,20}-\d{1,20}-\d{1,20}-[a-fA-F\d]+/g,
  },
  {
    id: "slack-app",
    pattern: /xapp-\d-[A-Za-z0-9]{1,40}-\d{1,20}-[A-Za-z0-9]+/g,
  },
  {
    id: "stripe",
    pattern: /[sr]k_(?:test|live|prod)_[a-zA-Z0-9]{10}[a-zA-Z0-9]*/g,
  },
  {
    id: "aws-access-key-id",
    pattern: new RegExp(
      `${B}(?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[A-Z2-7]{16}(?![A-Za-z0-9])`,
      "g",
    ),
  },
  { id: "google-api-key", pattern: /AIza[\w-]{35}[\w-]*/g },
  { id: "npm", pattern: /npm_[A-Za-z0-9]{36}[A-Za-z0-9]*/g },
  { id: "pypi", pattern: /pypi-AgEIcHlwaS5vcmc[\w-]{50}[\w-]*/g },
  { id: "sendgrid", pattern: /SG\.[A-Za-z0-9=_.-]{66}[A-Za-z0-9=_.-]*/g },
  {
    id: "twilio",
    pattern: new RegExp(`${B}SK[0-9a-fA-F]{32}(?![A-Za-z0-9])`, "g"),
  },
  {
    id: "gitlab",
    pattern:
      /gl(?:pat|dt|rt|ft|oas|soat)-[0-9a-zA-Z_-]{20}[0-9a-zA-Z_-]*|glptt-[0-9a-f]{40}/g,
  },
  {
    id: "cloudflare-origin-ca",
    pattern: /v1\.0-[a-f0-9]{24}-[a-f0-9]{146}/g,
  },
  { id: "digitalocean", pattern: /dop_v1_[a-f0-9]{64}/g },
  { id: "shopify", pattern: /shpat_[a-fA-F0-9]{32}/g },
  {
    id: "tailscale",
    pattern:
      /tskey-(?:auth|api|client|scim)-[A-Za-z0-9]{6,}-[A-Za-z0-9]{16}[A-Za-z0-9]*/g,
  },
  {
    // Header, base64 body (also JSON-escaped newlines) and END line if any.
    id: "private-key",
    pattern:
      /-----BEGIN[ A-Z0-9_-]{0,100}PRIVATE KEY(?: BLOCK)?-----[A-Za-z0-9+/=\s\\]{0,16384}(?:-----END[ A-Z0-9_-]{0,100}PRIVATE KEY(?: BLOCK)?-----)?/g,
  },
];

/**
 * Linear literal-anchor precheck: true whenever some pattern above could
 * match, so a caller may skip scrubbing (or parsing) text it rejects. Every
 * pattern starts with one of these fixed literals; the tests assert a sample
 * of every pattern passes, so a new pattern must add its anchor here. Tokens
 * contain no JSON-escaped characters before their anchor, so the check is the
 * same on serialized JSON.
 */
export const VENDOR_TOKEN_PRECHECK =
  /gh[pousr]_|github_pat_|sk-|xox[bpeos]-|xapp-|[sr]k_|A3T|AKIA|ASIA|ABIA|ACCA|AIza|npm_|pypi-|SG\.|SK|gl(?:pat|dt|rt|ft|oas|soat|ptt)-|v1\.0-|dop_v1_|shpat_|tskey-|-----BEGIN/;

/** Replaces every prefixed vendor token in `text` with `replacement`. */
export function scrubVendorTokens(text: string, replacement: string): string {
  let out = text;
  for (const { pattern } of VENDOR_TOKEN_PATTERNS) {
    // Cheap guard: most strings have no candidate at all.
    pattern.lastIndex = 0;
    out = out.replace(pattern, replacement);
  }
  return out;
}
