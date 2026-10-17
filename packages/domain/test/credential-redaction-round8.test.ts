import { afterEach, describe, expect, it, vi } from "vitest";
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
const bs = (n: number) => "\\".repeat(n);

function details(text: string): string {
  const out = redactEventDataForType("provider/warning", {
    category: "config",
    details: text,
  }) as { details: string };
  expect(
    redactEventDataForType("provider/warning", out),
    "idempotent",
  ).toEqual(out);
  return out.details;
}

describe("round 8: an ignored quote never makes its partner an opener", () => {
  for (const header of HEADERS) {
    for (const quote of ['"', "'"]) {
      for (let depth = 0; depth <= 5; depth += 1) {
        const q = bs(depth) + quote;
        it(`${header} after x${q}!${q}, ${quote} depth ${depth}`, () => {
          const out = details(`x${q}!${q}; ${header}: prefix${q}${TAIL}`);
          expect(out).not.toContain(TAIL);
          expect(out.startsWith(`x${q}!${q}; ${header}: [redacted]`)).toBe(
            true,
          );
        });
      }
    }
  }

  it("covers other word-adjacent, concatenation and mixed-quote shapes", () => {
    const prefixes = [
      `_"!"`,
      `_'!'`,
      `é"!"`,
      `é'!'`,
      `日"!"`,
      `a_1"!"`,
      `x"!"y"!"`,
      `x'!'y'!'`,
      `x"a b"y"c d"`,
      `x"!"'!'`,
      `x'!'"!"`,
      `x"!" 'y'`,
      `echo x"$HOME"y`,
      `echo "a"x"!"`,
      `"a"x"!"`,
      `5" x"!"`,
      `${bs(2)}x"!"`,
      `x${bs(1)}"!${bs(1)}"`,
      `x${bs(3)}"!${bs(3)}"`,
      `a"b" c"!"`,
      `_'\"x'`,
      `x'y\"z`,
      `users'`,
      `x'y \"a\" z'`,
    ];
    for (const prefix of prefixes) {
      for (const header of HEADERS) {
        for (const q of ['"', "'", `${bs(1)}"`, `${bs(2)}'`]) {
          const text = `${prefix}; ${header}: prefix${q}${TAIL}`;
          expect(details(text), text).not.toContain(TAIL);
        }
      }
    }
  });

  it("holds on a later line only for that line", () => {
    const out = details(`x"!"\n; Cookie: prefix"${TAIL}`);
    expect(out).not.toContain(TAIL);
    expect(details(`x"!"\nsee 'Cookie: a=${TAIL}' next`)).toContain("next");
  });

  it("keeps text after a genuinely enclosing quote", () => {
    for (const [text, rest] of [
      [`earlier "ok" then curl -H 'Cookie: sid=${TAIL}' next`, "next"],
      [`x ${bs(1)}"Cookie: sid=${TAIL}${bs(1)}" next`, "next"],
      [`a 'b' c "X-Api-Key: ${TAIL}" next`, "next"],
    ] as const) {
      const out = details(text);
      expect(out, text).not.toContain(TAIL);
      expect(out, text).toContain(rest);
    }
  });

  it("scales linearly with many ignored quotes", () => {
    const run = (n: number) => {
      const text = `x"!" 5" it's _'a' Cookie: p"y `.repeat(n);
      const start = performance.now();
      details(text);
      return performance.now() - start;
    };
    run(2000);
    const small = Math.max(run(10000), 1);
    const large = run(40000);
    expect(large / small).toBeLessThan(12);
  });
});

const urlOf = (n: number, unit: string, tail = "%20") =>
  `https://example.invalid/?${unit.repeat(n)}${tail}`;

function imageEvent(url: string) {
  return {
    item: {
      type: "userMessage",
      id: "synthetic-message",
      content: [{ type: "image", url }],
    },
  };
}

function writePath(url: string): string {
  return redactEventDataJsonForType(
    "item/completed",
    JSON.stringify(imageEvent(url)),
  );
}

describe("round 8: the URL scanner is linear", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const shapes: Array<[string, (n: number) => string]> = [
    ["?a= repeats, trailing escape", (n) => urlOf(n, "a=1?")],
    [";a= repeats, trailing escape", (n) => `https://e.invalid/?${"a=1;".repeat(n)}%20`],
    ["?a= repeats, no escape", (n) => `https://e.invalid/?${"a=1?".repeat(n)}`],
    ["escape in every value", (n) => `https://e.invalid/?${"a=%20;".repeat(n)}%20`],
    ["escapes and & separators", (n) => `https://e.invalid/?${"a=%20&".repeat(n)}`],
    ["# and mixed separators", (n) => `https://e.invalid/#${"a=1?b=2;c=3#".repeat(n)}%20`],
    ["bare ? runs", (n) => `https://e.invalid/${"?".repeat(n * 4)}%20`],
    ["long keys without =", (n) => `https://e.invalid/?${"k".repeat(n * 4)}%20`],
    [
      "nested encodings",
      (n) =>
        `https://e.invalid/?x=${encodeURIComponent(
          `https://i.invalid/?y=${encodeURIComponent(
            `https://j.invalid/?${"a=1?".repeat(n)}%20`,
          )}`,
        )}`,
    ],
    ["malformed escapes", (n) => `https://e.invalid/?${"a=%zz?".repeat(n)}%`],
  ];

  for (const [name, make] of shapes) {
    it(`16 KB and 64 KB bounds, doubling: ${name}`, () => {
      const time = (n: number) => {
        const url = make(n);
        const start = performance.now();
        const out = writePath(url);
        const ms = performance.now() - start;
        expect(out).toBe(JSON.stringify(imageEvent(url)));
        return { ms, length: url.length };
      };
      const small = time(4000);
      expect(small.length).toBeGreaterThan(8_000);
      expect(small.ms).toBeLessThan(1000); // was ~4000 ms at 16 KB
      const big = time(16000);
      expect(big.ms).toBeLessThan(2000);
      // 4x the input: a linear scan stays near 4x, a quadratic one near 16x.
      expect(big.ms / Math.max(small.ms, 1)).toBeLessThan(11);
    });
  }

  it("scans 64 KiB URL text on the object path and the plain-text path", () => {
    const url = urlOf(16000, "a=1?");
    for (const type of ["item/completed", "provider/warning"]) {
      const start = performance.now();
      const data =
        type === "item/completed"
          ? imageEvent(url)
          : { category: "config", details: url };
      const out = redactEventDataForType(type, data);
      expect(performance.now() - start).toBeLessThan(2000);
      expect(JSON.stringify(out)).toContain("a=1?a=1?");
    }
  });

  it("decodes each character a bounded number of times across nesting", () => {
    const spy = vi.spyOn(globalThis, "decodeURIComponent");
    const cost = (n: number) => {
      spy.mockClear();
      writePath(urlOf(n, "a=1?"));
      return spy.mock.calls.reduce(
        (sum, [arg]) => sum + String(arg).length,
        0,
      );
    };
    const a = cost(2000);
    const b = cost(4000);
    expect(b).toBeLessThan(a * 3);
    // total decoded input <= (nesting levels + 1) x the 16 KB URL
    expect(b).toBeLessThan(4 * 16_100);
  });

  it("still finds credentials after non-secret ?/; segments and nested", () => {
    const sig = "synthtail-123456789xyz";
    for (const url of [
      `https://e.invalid/?${"a=1?".repeat(500)}token=${sig}%20`,
      `https://e.invalid/?${"a=1;".repeat(500)}%20;sig=${sig}`,
      `https://e.invalid/?${"a=%20;".repeat(300)}next=https%3A%2F%2Fh.invalid%2F%3Ftoken%3D${sig}`,
      `https://e.invalid/?a=%zz;next=https%3A%2F%2Fh.invalid%2F%3Ftoken%3D${sig}`,
      `https://e.invalid/?${"a=%".repeat(50)};next=https%3A%2F%2Fh.invalid%2F%3Ftoken%3D${sig}`,
    ]) {
      const out = writePath(url);
      expect(out, url.slice(-80)).not.toContain(sig);
      expect(JSON.parse(out)).toBeTruthy();
    }
  });
});
