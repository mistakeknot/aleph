import { statSync, readFileSync } from "node:fs";
import { join } from "node:path";
export const HULL_DESIGNATIONS_FILE_NAME = "hull-designations.json";
export const HULL_DESIGNATIONS_ENV = "BB_HULL_DESIGNATIONS_FILE";

export type HullDesignations = Record<string, string>;

export function resolveHullDesignationsPath(
  dataDir: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const override = env[HULL_DESIGNATIONS_ENV];
  if (override !== undefined && override.trim().length > 0) return override;
  return join(dataDir, HULL_DESIGNATIONS_FILE_NAME);
}
export function parseHullDesignations(raw: unknown): HullDesignations {
  const result: HullDesignations = {};
  if (!Array.isArray(raw)) return result;
  for (const row of raw as unknown[]) {
    if (typeof row !== "object" || row === null) continue;
    const { projectId, threadId, designation, approved } = row as Record<
      string,
      unknown
    >;
    if (approved !== true) continue;
    const key = typeof threadId === "string" && threadId.length > 0 ? threadId : projectId;
    if (typeof key !== "string" || key.length === 0) continue;
    if (typeof designation !== "string") continue;
    const trimmed = designation.trim();
    if (trimmed.length === 0) continue;
    result[key] = trimmed;
  }
  return result;
}
export function createHullDesignationsReader(getPath: () => string) {
  let cached: {
    path: string;
    mtimeMs: number;
    size: number;
    value: HullDesignations;
  } | null = null;
  return function read(): HullDesignations {
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
      let value: HullDesignations;
      try {
        value = parseHullDesignations(
          JSON.parse(readFileSync(path, "utf8")) as unknown,
        );
      } catch {
        value = {};
      }
      cached = { path, mtimeMs: stat.mtimeMs, size: stat.size, value };
      return value;
    } catch {
      cached = null;
      return {};
    }
  };
}
