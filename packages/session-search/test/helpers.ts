import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  normalize,
  parseJsonl,
  type NormalizedRecord,
  type NormalizeSource,
} from "../src/index.js";

export const fixturesDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
);

export function fixturePath(name: string): string {
  return join(fixturesDir, name);
}

export function readFixtureText(name: string): string {
  return readFileSync(fixturePath(name), "utf8");
}

export function readFixtureBytes(name: string): Uint8Array {
  return new Uint8Array(readFileSync(fixturePath(name)));
}

export function normalizeJsonlText(
  text: string,
  source: NormalizeSource,
): NormalizedRecord[] {
  return parseJsonl(text).records.flatMap((record) =>
    normalize(record, source),
  );
}

export function normalizeFixture(
  name: string,
  source: NormalizeSource,
): NormalizedRecord[] {
  return normalizeJsonlText(readFixtureText(name), source);
}

export function ofKind<K extends NormalizedRecord["kind"]>(
  records: NormalizedRecord[],
  kind: K,
): Extract<NormalizedRecord, { kind: K }>[] {
  return records.filter(
    (record): record is Extract<NormalizedRecord, { kind: K }> =>
      record.kind === kind,
  );
}

export const claudeSessionId = "11111111-1111-4111-8111-111111111111";
export const codexSessionId = "22222222-2222-4222-8222-222222222222";
