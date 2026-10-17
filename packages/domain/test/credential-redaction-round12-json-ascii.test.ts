import { describe, expect, it } from "vitest";
import { redactEventDataForType } from "../src/index.js";
import { expandSecretVariants } from "../src/secret-variants.js";

/** Independent ensure_ascii serializer (does not use JSON.stringify). */
function asciiJsonOracle(text: string, upper = false): string {
  const short: Record<string, string> = {
    '"': '\\"',
    "\\": "\\\\",
    "\b": "\\b",
    "\f": "\\f",
    "\n": "\\n",
    "\r": "\\r",
    "\t": "\\t",
  };
  let out = "";
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    const code = text.charCodeAt(i);
    if (short[ch] !== undefined) {
      out += short[ch];
    } else if (code < 0x20 || code > 0x7e) {
      const hex = code.toString(16).padStart(4, "0");
      out += "\\u" + (upper ? hex.toUpperCase() : hex);
    } else {
      out += ch;
    }
  }
  return out;
}

const SECRETS: Record<string, string> = {
  "quote backslash newline non-ascii": 'syn"th\\sec\nr\u00e9t-9Zq',
  astral: "synth-\u{1f600}-s3cr3t-\u{1d11e}x",
  "tab and bell": "synth\tsec\u0007ret\u00fc!!",
  "control 1f and literal backslash-u": "synth\u001f-sec\\u00e9ret-\u00fc",
  "lone surrogate": "synth-s3cr3t-\ud800-tail\u00e9",
  "del and line separator": 'synth\u007f-sec\u2028ret-\u00e9\\"',
};

describe("ASCII-only JSON variant is built from JSON-escaped contents", () => {
  for (const [name, secret] of Object.entries(SECRETS)) {
    it(`${name}: registered and masked (both hex cases)`, () => {
      const variants = expandSecretVariants(secret)!;
      for (const upper of [false, true]) {
        const echo = asciiJsonOracle(secret, upper);
        expect(variants, echo).toContain(echo);
        const out = redactEventDataForType("provider/warning", {
          category: "config",
          details: `diag {"v":"${echo}"} end`,
          token: secret,
        }) as { details: string };
        expect(out.details).not.toContain(echo);
        expect(out.details).toContain("end");
      }
    });
  }

  it("keeps the existing variants", () => {
    const secret = SECRETS["quote backslash newline non-ascii"]!;
    const variants = expandSecretVariants(secret)!;
    expect(variants).toContain(JSON.stringify(secret).slice(1, -1));
    expect(variants).toContain(
      secret.replace(
        /[^\x20-\x7e]/g,
        (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"),
      ),
    );
  });
});
