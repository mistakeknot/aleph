import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { fixturePath, readFixtureText } from "./helpers.js";

const FORBIDDEN: readonly RegExp[] = [
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/,
  /\/home\//,
  /\/Users\//,
  /\bsk-[A-Za-z0-9_-]{10,}/,
  /\bgh[pousr]_[A-Za-z0-9]{10,}/,
  /\bxox[a-z]-/,
  /\bAKIA[0-9A-Z]{8,}/,
  /Bearer\s+[A-Za-z0-9._-]{8,}/,
  /BEGIN [A-Z ]*PRIVATE KEY/,
  /\.ts\.net|\.local\b|localhost/,
];

function listFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? listFiles(path) : [path];
  });
}

describe("fixture corpus", () => {
  const root = fixturePath("");
  const files = listFiles(root);

  it("contains the expected artifacts", () => {
    const names = files
      .map((file) => file.slice(root.length).replace(/^\/+/, ""))
      .sort();
    expect(names).toEqual([
      "bb/events.json",
      "claude/session-main.jsonl",
      "claude/subagent-agent-a1.jsonl",
      "codex/rollout.jsonl",
    ]);
  });

  it.each(files)("has no secrets, hostnames or private paths: %s", (file) => {
    const text = readFixtureText(file.slice(root.length).replace(/^\/+/, ""));
    for (const pattern of FORBIDDEN) {
      expect(text, String(pattern)).not.toMatch(pattern);
    }
  });
});
