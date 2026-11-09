import { statSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeHullName } from "./hull-names.js";
export const HULL_DESIGNATIONS_FILE_NAME = "hull-designations.json";
export const HULL_DESIGNATIONS_ENV = "BB_HULL_DESIGNATIONS_FILE";

export type HullDesignations = Record<string, string>;

export interface HullDesignationData {
  designations: HullDesignations;
  names: HullDesignations;
}

function emptyData(): HullDesignationData {
  return { designations: {}, names: {} };
}

export function resolveHullDesignationsPath(
  dataDir: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const override = env[HULL_DESIGNATIONS_ENV];
  if (override !== undefined && override.trim().length > 0) return override;
  return join(dataDir, HULL_DESIGNATIONS_FILE_NAME);
}
function nameCandidates(name: unknown, aliases: unknown): string[] {
  const candidates: string[] = [];
  if (typeof name === "string") candidates.push(name);
  if (Array.isArray(aliases)) {
    for (const alias of aliases as unknown[]) {
      if (typeof alias === "string") candidates.push(alias);
    }
  }
  return candidates;
}

export function parseHullDesignations(raw: unknown): HullDesignationData {
  const data = emptyData();
  if (!Array.isArray(raw)) return data;
  const byName = new Map<string, string | null>();
  for (const row of raw as unknown[]) {
    if (typeof row !== "object" || row === null) continue;
    const { projectId, threadId, designation, approved, name, aliases } =
      row as Record<string, unknown>;
    if (approved !== true) continue;
    if (typeof designation !== "string") continue;
    const trimmed = designation.trim();
    if (trimmed.length === 0) continue;
    const key =
      typeof threadId === "string" && threadId.length > 0
        ? threadId
        : projectId;
    if (typeof key === "string" && key.length > 0) {
      data.designations[key] = trimmed;
    }
    for (const candidate of nameCandidates(name, aliases)) {
      const normalized = normalizeHullName(candidate);
      if (normalized.length === 0) continue;
      const existing = byName.get(normalized);
      if (existing === undefined) byName.set(normalized, trimmed);
      else if (existing !== trimmed) byName.set(normalized, null);
    }
  }
  for (const [normalized, designation] of byName) {
    if (designation !== null) data.names[normalized] = designation;
  }
  return data;
}
export function createHullDesignationsReader(getPath: () => string) {
  let cached: {
    path: string;
    mtimeMs: number;
    size: number;
    value: HullDesignationData;
  } | null = null;
  return function read(): HullDesignationData {
    const path = getPath();
    try {
      const stat = statSync(path);
      if (
        cached !== null &&
        cached.path === path &&
        cached.mtimeMs === stat.mtimeMs &&
        cached.size === stat.size
      ) {
        return cached.value;
      }
      let value: HullDesignationData;
      try {
        value = parseHullDesignations(
          JSON.parse(readFileSync(path, "utf8")) as unknown,
        );
      } catch {
        value = emptyData();
      }
      cached = { path, mtimeMs: stat.mtimeMs, size: stat.size, value };
      return value;
    } catch {
      cached = null;
      return emptyData();
    }
  };
}
