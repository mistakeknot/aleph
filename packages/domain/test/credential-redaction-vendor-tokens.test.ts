import { describe, expect, it } from "vitest";
import {
  parseStoredThreadEvent,
  redactEventDataForType,
  redactEventDataJsonForType,
  redactThreadEventPayload,
  threadScope,
} from "../src/index.js";
import {
  VENDOR_TOKEN_PATTERNS,
  scrubVendorTokens,
} from "../src/vendor-token-patterns.js";

// Synthetic tokens are assembled at runtime from prefix + filler so no
// literal in this file looks like a real credential to a secret scanner.
const f = (chars: string, n: number) => chars.repeat(n).slice(0, n);
const AZ = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const az = "abcdefghijklmnopqrstuvwxyz";
const D = "0123456789";
const ALNUM = AZ + az + D;
const HEX = "0123456789abcdef";
const b = "-----BEGIN ";
const e = "-----END ";

const SAMPLES: Record<string, string> = {
  "github-pat": "gh" + "p_" + f(ALNUM, 36),
  "github-oauth": "gh" + "o_" + f(ALNUM, 36),
  "github-app": "gh" + "s_" + f(ALNUM, 40),
  "github-refresh": "gh" + "r_" + f(ALNUM, 36),
  "github-fine-grained": "github" + "_pat_" + f(ALNUM + "_", 82),
  anthropic: "sk-" + "ant-api03-" + f(ALNUM + "_-", 93) + "AA",
  "openai-project":
    "sk-" + "proj-" + f(ALNUM, 74) + "T3Blbk" + "FJ" + f(ALNUM, 74),
  "openai-legacy": "sk-" + f(ALNUM, 20) + "T3Blbk" + "FJ" + f(ALNUM, 20),
  "slack-bot": "xox" + "b-" + f(D, 11) + "-" + f(D, 12) + "-" + f(ALNUM, 24),
  "slack-user":
    "xox" +
    "p-" +
    f(D, 11) +
    "-" +
    f(D, 11) +
    "-" +
    f(D, 12) +
    "-" +
    f(ALNUM, 30),
  "slack-legacy":
    "xox" +
    "s-" +
    f(D, 11) +
    "-" +
    f(D, 11) +
    "-" +
    f(D, 11) +
    "-" +
    f(HEX, 24),
  "slack-app":
    "xapp" + "-1-" + f(AZ + D, 11) + "-" + f(D, 13) + "-" + f(az + D, 40),
  stripe: "sk" + "_live_" + f(ALNUM, 24),
  "aws-access-key-id": "AK" + "IA" + f(AZ, 16),
  "google-api-key": "AI" + "za" + f(ALNUM, 35),
  npm: "npm" + "_" + f(ALNUM, 36),
  pypi: "pypi-" + "AgEIcHlwaS5vcmc" + f(ALNUM, 60),
  sendgrid: "SG" + "." + f(ALNUM, 22) + "." + f(ALNUM, 43),
  twilio: "S" + "K" + f(HEX, 32),
  gitlab: "gl" + "pat-" + f(ALNUM, 20),
  "cloudflare-origin-ca": "v1." + "0-" + f(HEX, 24) + "-" + f(HEX, 146),
  digitalocean: "dop" + "_v1_" + f(HEX, 64),
  shopify: "shp" + "at_" + f(HEX, 32),
  tailscale: "tskey" + "-auth-" + f(ALNUM, 12) + "-" + f(ALNUM, 32),
  "private-key":
    b +
    "OPENSSH PRIVATE" +
    " KEY-----\n" +
    f(ALNUM + "+/", 200) +
    "\n" +
    e +
    "OPENSSH PRIVATE" +
    " KEY-----",
};

describe("vendored prefixed token patterns", () => {
  it("has a sample for every pattern and 15-25 patterns", () => {
    const ids = new Set(VENDOR_TOKEN_PATTERNS.map((p) => p.id));
    expect([...ids].sort()).toEqual(Object.keys(SAMPLES).sort());
    expect(VENDOR_TOKEN_PATTERNS.length).toBeGreaterThanOrEqual(15);
    expect(VENDOR_TOKEN_PATTERNS.length).toBeLessThanOrEqual(25);
  });

  for (const [id, token] of Object.entries(SAMPLES)) {
    it(`${id}: masked in free text, idempotent, context kept`, () => {
      const text = `before ${token} after`;
      const once = scrubVendorTokens(text, "[redacted]");
      expect(once).toBe("before [redacted] after");
      expect(scrubVendorTokens(once, "[redacted]")).toBe(once);
    });

    it(`${id}: masked on all four redaction paths`, () => {
      const data = { category: "config", details: `run with ${token} now` };
      const object = redactEventDataForType("provider/warning", data) as {
        details: string;
      };
      expect(object.details).toBe("run with [redacted] now");
      expect(redactEventDataForType("provider/warning", object)).toEqual(
        object,
      );
      const json = JSON.parse(
        redactEventDataJsonForType("provider/warning", JSON.stringify(data)),
      ) as { details: string };
      expect(json.details).toBe(object.details);
      const emitted = redactThreadEventPayload({
        type: "provider/warning",
        threadId: "thr_synthetic",
        providerThreadId: "synthetic-provider",
        scope: threadScope(),
        ...data,
      } as { type: string }) as unknown as { details: string };
      expect(emitted.details).toBe(object.details);
      const decoded = parseStoredThreadEvent({
        type: "provider/warning",
        data,
        providerThreadId: "synthetic-provider",
        scope: threadScope(),
        threadId: "thr_synthetic",
      }) as unknown as { details: string };
      expect(decoded.details).toBe(object.details);
    });
  }

  it("masks tokens in tool output text, but leaves authored text untouched", () => {
    const token = SAMPLES["github-pat"]!;
    const tool = redactEventDataForType("item/completed", {
      item: { type: "commandExecution", aggregatedOutput: `got ${token}` },
    });
    expect(JSON.stringify(tool)).not.toContain(token);
    const authored = redactEventDataForType("item/completed", {
      item: { type: "userMessage", content: [{ type: "text", text: token }] },
    });
    expect(JSON.stringify(authored)).toContain(token);
  });

  it("leaves ordinary text alone (false-positive controls)", () => {
    const ordinary = [
      "the ghp_ prefix is documented by GitHub",
      "see sk-learn and sk-ant for naming; sk-proj- is a prefix",
      "AKIA is short, as is ASIA; AKIAshort and ASIAEXAMPLE are not keys",
      "SKU12345 and SK1234 and skeleton_key and task_live_view",
      "xoxo hugs; xox-notes; xapp-1; npm_config_cache; npm_package_name",
      "-----BEGIN CERTIFICATE----- is public, as is -----BEGIN PUBLIC KEY-----",
      "glpat is a prefix, glob-pattern-matching-is-fun, gl-rt-short",
      "ordinary text with numbers 1234567890 and hex deadbeefdeadbeef",
      "https://example.invalid/path?tskey=short&AIza=short",
      "2026-10-03T12:00:00Z commit b58d3f102cf3a2c84cb7f923d05c25c9b1aed84b",
      "SG.short.value and dop_v1_nothex and shpat_zz",
      "pypi-short and github_pat_short and v1.0-abc-def",
      "x".repeat(300),
      "word ".repeat(200),
    ];
    for (const text of ordinary) {
      expect(scrubVendorTokens(text, "[redacted]"), text).toBe(text);
    }
  });

  it("does not match a token embedded in a longer word (boundary rules)", () => {
    for (const id of ["aws-access-key-id", "twilio"]) {
      const token = SAMPLES[id]!;
      const embedded = `x${token}`;
      expect(scrubVendorTokens(embedded, "[redacted]"), id).toBe(embedded);
      expect(scrubVendorTokens(`${token}x`, "[redacted]"), id).toBe(
        `${token}x`,
      );
    }
  });

  it("consumes a longer-than-expected tail instead of leaving it", () => {
    const token = SAMPLES["github-pat"]! + "ZZZZZZZZ";
    expect(scrubVendorTokens(`a ${token} b`, "[redacted]")).toBe(
      "a [redacted] b",
    );
  });
});

describe("vendored patterns run in linear time", () => {
  const MB = 1_000_000;
  // Adversarial inputs: a prefix repeated (a start at every few bytes), a
  // near-complete token, a long class run, and an unterminated private key.
  const inputs: Record<string, string> = {};
  for (const { id } of VENDOR_TOKEN_PATTERNS) {
    const token = SAMPLES[id]!;
    const prefix = token.slice(0, Math.min(16, token.length - 1));
    inputs[`${id}: repeated prefix`] = prefix.repeat(
      Math.ceil(MB / prefix.length),
    );
    const nearly = token.slice(0, -1);
    inputs[`${id}: repeated near-miss`] = (nearly + " ").repeat(
      Math.ceil(MB / (nearly.length + 1)),
    );
  }
  inputs["long class run"] = "a".repeat(MB);
  inputs["dashes and words"] = "-----BEGIN ".repeat(MB / 11);
  inputs["header spam, no end"] = (b + "PRIVATE" + " KEY-----\n").repeat(
    MB / 28,
  );
  inputs["header with long body"] =
    b + "PRIVATE" + " KEY-----" + "A".repeat(MB);

  const time = (text: string): number => {
    const start = performance.now();
    scrubVendorTokens(text, "[redacted]");
    return performance.now() - start;
  };

  for (const [name, text] of Object.entries(inputs)) {
    it(`1 MB adversarial input (${name})`, () => {
      expect(time(text)).toBeLessThan(1500);
    });
  }

  it("doubling the input about doubles the time", () => {
    const unit = "ghp_" + "a".repeat(30) + " ";
    const t1 = Math.max(time(unit.repeat(20_000)), 1);
    const t2 = time(unit.repeat(80_000));
    expect(t2 / t1).toBeLessThan(4 * 4);
  });
});
