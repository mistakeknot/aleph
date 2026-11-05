import { describe, expect, it } from "vitest";

import { reconcileDotenv as pluginReconcile } from "../../../../plugins/secrets/src/dotenv.js";
import { reconcileDotenv as hostReconcile } from "./secret-dotenv.js";

function accepts(
  reconcile: (content: string, values: Record<string, string>) => unknown,
  value: string,
): boolean {
  try {
    reconcile("", { API_ONE: value });
    return true;
  } catch {
    return false;
  }
}

const ATOMS = [
  "a",
  " ",
  "\\",
  "'",
  '"',
  "`",
  "#",
  "=",
  ":",
  "n",
  "$",
  "{",
  "\t",
  "é",
];

function* values(): Generator<string> {
  yield "plain";
  yield " padded\\";
  yield "ends-with-backslash\\";
  yield "a\\\\";
  yield "a\\n b";
  yield "a'b\"c#d";
  yield "a'b\"c`d";
  yield "  ";
  yield "x # y";
  yield "${HOME}";
  for (const first of ATOMS)
    for (const second of ATOMS)
      for (const third of ATOMS) {
        yield `${first}${second}${third}`;
        for (const fourth of ATOMS) yield `${first}${second}${third}${fourth}`;
      }
}

describe("plugin form validation matches host encoder", () => {
  it("never accepts a value the host refuses", () => {
    const mismatches: string[] = [];
    for (const value of values()) {
      if (accepts(pluginReconcile, value) && !accepts(hostReconcile, value)) {
        mismatches.push(JSON.stringify(value));
        if (mismatches.length >= 20) break;
      }
    }
    expect(mismatches).toEqual([]);
  });

  it("refuses the leading-space trailing-backslash value in the form", () => {
    expect(accepts(pluginReconcile, " padded\\")).toBe(false);
    expect(accepts(hostReconcile, " padded\\")).toBe(false);
  });
});
