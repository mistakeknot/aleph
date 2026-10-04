import { describe, expect, it } from "vitest";
import {
  redactEventDataForType,
  redactEventDataJsonForType,
} from "../src/index.js";

const TAIL = "synthtail-123456789xyz";
const HEADERS = [
  "Cookie",
  "Set-Cookie",
  "Authorization",
  "Proxy-Authorization",
  "X-Api-Key",
  "X-Auth-Token",
  "X-Access-Token",
];
const SUFFIXES = ["s", "t", "d", "m", "ll", "re", "ve"];
const PREFIXES = ["x", "it", "é", "日", "_", "\u{10400}"];
const bs = (n: number) => "\\".repeat(n);

function details(text: string): string {
  const out = redactEventDataForType("provider/warning", {
    category: "config",
    details: text,
  }) as { details: string };
  expect(redactEventDataForType("provider/warning", out), "idempotent").toEqual(
    out,
  );
  return out.details;
}

describe("round 9: no English-contraction exception for header quotes", () => {
  it("masks the reviewer fixture through the end of the line", () => {
    expect(details(`x's!'; Cookie: prefix'${TAIL}`)).toBe(
      `x's!'; Cookie: [redacted]`,
    );
  });

  for (const header of HEADERS) {
    for (let depth = 0; depth <= 5; depth += 1) {
      it(`${header}: suffixes x prefixes, backslash depth ${depth}`, () => {
        const q = bs(depth) + "'";
        for (const prefix of PREFIXES) {
          for (const suffix of SUFFIXES) {
            const text = `${prefix}${q}${suffix}!${q}; ${header}: prefix${q}${TAIL}`;
            const out = details(text);
            expect(out, text).not.toContain(TAIL);
            expect(out, text).toMatch(/\[redacted\]$/);
          }
        }
      });
    }
  }

  it("applies to the JSON write helper too", () => {
    const text = `x's!'; Cookie: prefix'${TAIL}`;
    const out = redactEventDataJsonForType(
      "provider/warning",
      JSON.stringify({ category: "config", details: text }),
    );
    expect(out).not.toContain(TAIL);
  });

  it("sibling shapes fail closed", () => {
    const prefixes = [
      `x'z!'`,
      `users'`,
      `it's`,
      `don't`,
      `é's!'`,
      `日's!'`,
      `x\\'s!\\'`,
      `x\\\\'t!\\\\'`,
      `x's!' y's!'`,
      `x's!'"!"`,
      `x"!"'s!'`,
      `x's"`,
      `it's said`,
    ];
    for (const prefix of prefixes) {
      for (const header of HEADERS) {
        for (const q of ["'", '"', `${bs(1)}'`, `${bs(2)}"`]) {
          const text = `${prefix}; ${header}: prefix${q}${TAIL}`;
          expect(details(text), text).not.toContain(TAIL);
        }
      }
    }
  });

  it("over-redacts prose with an apostrophe before a header (accepted)", () => {
    const out = details(`it's said "Authorization: Bearer ${TAIL}" next`);
    expect(out).not.toContain(TAIL);
    expect(out).not.toContain("next");
  });

  it("keeps text after genuinely enclosing quotes", () => {
    for (const [text, rest] of [
      [`curl -H 'Cookie: sid=${TAIL}' next`, "next"],
      [`say "Authorization: Bearer ${TAIL}" next`, "next"],
      [`x ${bs(1)}"Cookie: sid=${TAIL}${bs(1)}" next`, "next"],
      [`a 'b' c "X-Api-Key: ${TAIL}" next`, "next"],
      [`earlier "ok" then curl -H 'Cookie: sid=${TAIL}' next`, "next"],
      [`"it's fine" then 'Cookie: sid=${TAIL}' next`, "next"],
    ] as const) {
      const out = details(text);
      expect(out, text).not.toContain(TAIL);
      expect(out, text).toContain(rest);
    }
  });
});
