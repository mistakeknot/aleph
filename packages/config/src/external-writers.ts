import { join, resolve, sep } from "node:path";

export const MINIMUM_FENCE_AWARE_ALEPH_VERSION = "0.5.0";

export type ExternalWriterReason = "predates_fence" | "unprobeable";

export interface ExternalWriter {
  path: string;
  version: string | null;
  reason: ExternalWriterReason;
}

export interface ExternalWriterReport {
  autoUpdateAllowed: boolean;
  writers: ExternalWriter[];
}

const ALEPH_VERSION_PATTERN = /\+aleph\.(\d+)\.(\d+)\.(\d+)(?:$|[-+.])/u;

function parseTriple(value: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)$/u.exec(value);
  if (match === null) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function isFenceAwareVersion(version: string): boolean {
  const match = ALEPH_VERSION_PATTERN.exec(version.trim());
  const minimum = parseTriple(MINIMUM_FENCE_AWARE_ALEPH_VERSION);
  if (match === null || minimum === null) return false;
  const actual: [number, number, number] = [
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
  ];
  for (let index = 0; index < 3; index += 1) {
    if (actual[index]! !== minimum[index]!) {
      return actual[index]! > minimum[index]!;
    }
  }
  return true;
}

export function defaultWriterCandidates(args: {
  homeDir: string;
  pathEnv: string | undefined;
}): string[] {
  const candidates: string[] = [];
  for (const directory of (args.pathEnv ?? "").split(":")) {
    if (directory !== "") candidates.push(join(directory, "bb"));
  }
  candidates.push(
    join(args.homeDir, ".local", "bin", "bb"),
    join(args.homeDir, ".aleph", "npm", "bin", "bb"),
    join(args.homeDir, ".aleph", "npm", "bin", "bb-app"),
    "/usr/local/bin/bb",
    "/opt/homebrew/bin/bb",
  );
  return [...new Set(candidates)];
}

function isInside(path: string, directory: string): boolean {
  const resolvedDirectory = resolve(directory);
  const resolvedPath = resolve(path);
  return (
    resolvedPath === resolvedDirectory ||
    resolvedPath.startsWith(resolvedDirectory + sep)
  );
}

export async function detectExternalWriters(args: {
  candidates: readonly string[];
  bundlePath: string;
  probeVersion: (path: string) => Promise<string | null>;
  isStockBb?: (version: string) => boolean;
}): Promise<ExternalWriterReport> {
  const writers: ExternalWriter[] = [];
  const seen = new Set<string>();
  for (const candidate of args.candidates) {
    if (seen.has(candidate) || isInside(candidate, args.bundlePath)) continue;
    seen.add(candidate);
    let version: string | null;
    try {
      version = await args.probeVersion(candidate);
    } catch {
      version = null;
    }
    if (version === null || version.trim() === "") {
      writers.push({ path: candidate, version: null, reason: "unprobeable" });
      continue;
    }
    if (args.isStockBb?.(version) === true) continue;
    if (!isFenceAwareVersion(version)) {
      writers.push({ path: candidate, version, reason: "predates_fence" });
    }
  }
  return { autoUpdateAllowed: writers.length === 0, writers };
}
