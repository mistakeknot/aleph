import { expect, it } from "vitest";
import { redactEventDataForType } from "../src/provider-env-redaction.js";
import { cpuTimeMs } from "./cpu-time.js";

const N = 100_000;
const CPU_CEILING_MS = 6407.92;
const uncountedBypasses = [
  "Object.keys",
  "for-in",
  "Reflect.ownKeys",
  "toSorted",
  "typed-array sorting",
  "regex literals and species construction",
  "individual trie transitions",
  "encoding loops",
  "fail-closed cap removal",
  "native regex backtracking",
  "allocation and helper-thread GC",
];

it("bounds large traversals and secret-set matching work for very many secret-named entries", () => {
  const env: Record<string, string> = {};
  for (let i = 0; i < N; i += 1) env[`API_KEY_${i}`] = `secret-value-${i}-xx`;
  redactEventDataForType("provider/unhandled", {
    env: { API_KEY: "warmup-secret-value" },
    text: "warmup",
  });
  for (const data of [{ env, text: "x".repeat(200_000) }, { env }]) {
    const reference = redactEventDataForType("provider/unhandled", data);
    const entries = Object.entries;
    const sort = Array.prototype.sort;
    const NativeRegExp = globalThis.RegExp;
    let largeTraversals = 0;
    let sortedSecretElements = 0;
    let secretPatternChars = 0;
    let elapsed = 0;
    let out: typeof data;
    const countPattern = (pattern: unknown) => {
      const source =
        pattern instanceof NativeRegExp
          ? pattern.source
          : String(pattern ?? "");
      if (source.length >= N) secretPatternChars += source.length;
    };
    try {
      Object.entries = ((value: object) => {
        const result = entries(value);
        if (result.length >= N) largeTraversals += 1;
        return result;
      }) as typeof Object.entries;
      Array.prototype.sort = function (compare) {
        if (this.length >= N) sortedSecretElements += this.length;
        return sort.call(this, compare);
      };
      globalThis.RegExp = new Proxy(NativeRegExp, {
        construct(target, args, newTarget) {
          countPattern(args[0]);
          return Reflect.construct(target, args, newTarget);
        },
        apply(target, receiver, args) {
          countPattern(args[0]);
          return Reflect.apply(target, receiver, args);
        },
      });
      const start = cpuTimeMs();
      out = redactEventDataForType("provider/unhandled", data);
      elapsed = cpuTimeMs() - start;
    } finally {
      Object.entries = entries;
      Array.prototype.sort = sort;
      globalThis.RegExp = NativeRegExp;
    }
    expect(largeTraversals).toBeLessThanOrEqual(4);
    expect(sortedSecretElements).toBe(0);
    expect(secretPatternChars).toBe(0);
    expect(out).toEqual(reference);
    expect(JSON.stringify(out)).not.toContain("secret-value-5-xx");
    expect(
      elapsed,
      `CPU backstop; work counter bypasses: ${uncountedBypasses.join(", ")}`,
    ).toBeLessThan(CPU_CEILING_MS);
  }
}, 60_000);
