import { describe, expect, it } from "vitest";
import { redactEventDataForType } from "../src/index.js";
import {
  MAX_EXPANDABLE_SECRET_CHARS,
  MAX_VARIANTS_PER_SECRET,
  MAX_VARIANT_EXPANSION,
  MIN_EXPANDED_SECRET_LENGTH,
  expandSecretVariants,
} from "../src/secret-variants.js";

// Node's Buffer is the independent oracle (the package has no node typings).
interface Buf {
  toString(encoding?: "base64" | "hex" | "utf8"): string;
  [index: number]: number;
  length: number;
  [Symbol.iterator](): Iterator<number>;
}
const Buffer = (
  globalThis as unknown as {
    Buffer: { from(text: string, encoding: "utf8"): Buf };
  }
).Buffer;
type Buffer = Buf;

// Synthetic, with characters every transform has to touch.
const SECRET = "synth S3cr'et\"$x/+=é?&-9Zq";

function scrub(details: string, secret = SECRET): string {
  const out = redactEventDataForType("provider/warning", {
    category: "config",
    details,
    token: secret,
  }) as { details: string };
  expect(redactEventDataForType("provider/warning", out), "idempotent").toEqual(
    out,
  );
  return out.details;
}

const bytes = Buffer.from(SECRET, "utf8");
const b64url = (b: Buffer) =>
  b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_");

const ECHOES: Record<string, string> = {
  raw: SECRET,
  "percent (component)": encodeURIComponent(SECRET),
  "percent (form +)": encodeURIComponent(SECRET).replace(/%20/g, "+"),
  "percent (lowercase)": encodeURIComponent(SECRET).replace(
    /%[0-9A-F]{2}/g,
    (m) => m.toLowerCase(),
  ),
  "percent (every byte)": [...bytes]
    .map((b) => "%" + b.toString(16).toUpperCase().padStart(2, "0"))
    .join(""),
  "base64 padded": bytes.toString("base64"),
  "base64 unpadded": bytes.toString("base64").replace(/=+$/, ""),
  "base64url padded": b64url(bytes),
  "base64url unpadded": b64url(bytes).replace(/=+$/, ""),
  json: JSON.stringify(SECRET).slice(1, -1),
  "json twice": JSON.stringify(JSON.stringify(SECRET).slice(1, -1)).slice(
    1,
    -1,
  ),
  "json ascii": SECRET.replace(
    /[^\x20-\x7e]/g,
    (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"),
  ),
  "shell backslash": SECRET.replace(/[^A-Za-z0-9_@%+=:./-]/g, "\\$&"),
  "shell backslash all": SECRET.replace(/[^A-Za-z0-9]/g, "\\$&"),
  "shell single quoted": `'${SECRET.replace(/'/g, "'\\''")}'`,
  "shell double quoted": `"${SECRET.replace(/[\\"$`]/g, "\\$&")}"`,
  hex: bytes.toString("hex"),
  HEX: bytes.toString("hex").toUpperCase(),
};

describe("known-secret variant expansion", () => {
  for (const [name, echo] of Object.entries(ECHOES)) {
    it(`redacts the ${name} echo`, () => {
      const out = scrub(`before ${echo} after`);
      expect(out).toContain("before ");
      expect(out).toContain(" after");
      expect(out).toContain("[redacted]");
      for (const piece of [echo, echo.slice(4, -4)]) {
        expect(out.includes(piece), `${name}: ${out}`).toBe(false);
      }
    });
  }

  for (const lead of [0, 1, 2]) {
    for (const [alphabet, enc] of [
      ["standard", (b: Buffer) => b.toString("base64")],
      ["url-safe", b64url],
    ] as const) {
      it(`redacts base64 (${alphabet}) of a blob embedding the secret at alignment ${lead}`, () => {
        const blob = enc(
          Buffer.from("x".repeat(lead) + SECRET + ":after", "utf8"),
        );
        const out = scrub(`Authorization: Basic ${blob}`);
        const stable = enc(Buffer.from("x".repeat(lead) + SECRET, "utf8"))
          .replace(/=+$/, "")
          .slice([0, 2, 3][lead]!, -3);
        expect(out.includes(stable), out).toBe(false);
      });
    }
  }

  it("does not expand secrets shorter than the minimum (8 characters)", () => {
    expect(MIN_EXPANDED_SECRET_LENGTH).toBe(8);
    expect(expandSecretVariants("abc'd e")).toEqual(["abc'd e"]);
    expect(expandSecretVariants("abcdefgh")!.length).toBeGreaterThan(1);
  });

  it("drops variants shorter than the minimum", () => {
    for (const v of expandSecretVariants("abcdefgh")!) {
      expect(v.length).toBeGreaterThanOrEqual(8);
    }
  });

  it("bounds the number and size of variants", () => {
    for (const secret of [
      SECRET,
      "\u0001".repeat(64),
      "é".repeat(500),
      "\u{1F600}".repeat(200),
      "'".repeat(1000),
      "a".repeat(MAX_EXPANDABLE_SECRET_CHARS),
    ]) {
      const variants = expandSecretVariants(secret)!;
      expect(variants.length).toBeLessThanOrEqual(MAX_VARIANTS_PER_SECRET);
      let total = 0;
      for (const v of variants) {
        total += v.length;
      }
      expect(total).toBeLessThanOrEqual(MAX_VARIANT_EXPANSION * secret.length);
    }
  });

  it("refuses an oversized secret and the payload fails closed", () => {
    const huge = "q".repeat(MAX_EXPANDABLE_SECRET_CHARS + 1);
    expect(expandSecretVariants(huge)).toBeNull();
    const out = redactEventDataForType("provider/warning", {
      category: "config",
      details: "ordinary text without the secret",
      token: huge,
    }) as { details: string };
    expect(out.details).toBe("[redacted]");
  });

  it("fails closed when the indexed variants exceed the memory ceiling", () => {
    // 100 distinct 60K secrets: each expands past the 4M-character ceiling.
    const secrets = Array.from(
      { length: 100 },
      (_, i) => `${i}`.padStart(4, "0") + "z".repeat(60_000),
    );
    const out = redactEventDataForType("provider/warning", {
      category: "config",
      details: "ordinary text",
      env: Object.fromEntries(secrets.map((s, i) => [`API_TOKEN_${i}`, s])),
    }) as { details: string };
    expect(out.details).toBe("[redacted]");
  });

  it("stays linear: many secrets over a large text", () => {
    const secrets = Array.from(
      { length: 300 },
      (_, i) => `synthetic-secret-${i}-${"k".repeat(20)}`,
    );
    const env = Object.fromEntries(
      secrets.map((s, i) => [`API_TOKEN_${i}`, s]),
    );
    const text = "ordinary words and numbers 12345 ".repeat(40_000);
    const time = (n: number) => {
      const t = performance.now();
      redactEventDataForType("provider/warning", {
        category: "config",
        details: text.slice(0, n) + secrets[7],
        env,
      });
      return performance.now() - t;
    };
    time(1000);
    const small = Math.max(time(200_000), 1);
    const large = time(1_200_000);
    expect(large / small).toBeLessThan(6 * 3);
    expect(large).toBeLessThan(8000);
  });
});
