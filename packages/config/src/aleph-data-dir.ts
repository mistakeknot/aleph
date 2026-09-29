import { existsSync, readFileSync, realpathSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { basename, dirname, join, relative, resolve, sep, isAbsolute } from "node:path";
import { isAlephAppVersion } from "./aleph-version.js";
import { formatBbAppRuntimeFilePath } from "./app-runtime-file.js";
import { resolveDataDirDatabasePath } from "./runtime.js";

export const ALEPH_FORK_MIGRATION_WHENS = [1790349911647, 1790350024036] as const;

const STOCK_DATA_DIR_NAME = ".bb";
const DEV_APP_VERSION = "0.0.0-dev";
const MIGRATIONS_TABLE = "__drizzle_migrations";

export type AlephDataDirRefusalReason =
  | "inside_stock_bb_dir"
  | "stock_bb_database"
  | "stock_bb_runtime_file";

export interface AlephDataDirRefusal {
  reason: AlephDataDirRefusalReason;
  detail: string;
}

export interface AlephDataDirCheckArgs {
  dataDir: string;
  homeDir: string;
}

export class AlephDataDirRefusedError extends Error {
  constructor(
    readonly dataDir: string,
    readonly refusal: AlephDataDirRefusal,
  ) {
    super(
      `Aleph refuses to use ${dataDir} (${refusal.reason}): ${refusal.detail}. Aleph keeps its data in ~/.aleph and never shares a directory with stock bb.`,
    );
  }
}

function realpathWithMissingTail(path: string): string {
  const absolute = resolve(path);
  const missing: string[] = [];
  let probe = absolute;
  for (;;) {
    try {
      return join(realpathSync(probe), ...missing.reverse());
    } catch {
      const parent = dirname(probe);
      if (parent === probe) return absolute;
      missing.push(basename(probe));
      probe = parent;
    }
  }
}

function isInside(args: { child: string; parent: string }): boolean {
  const rel = relative(args.parent, args.child);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function stockDirectories(homeDir: string): string[] {
  const candidates = [
    join(homeDir, STOCK_DATA_DIR_NAME),
    join(homeDir, "Library", "Application Support", "bb"),
  ];
  return candidates.flatMap((candidate) => [
    resolve(candidate),
    realpathWithMissingTail(candidate),
  ]);
}

function hasStockMigrationHistory(dataDir: string): boolean {
  const databasePath = resolveDataDirDatabasePath({ dataDir });
  if (!existsSync(databasePath)) return false;
  let database: DatabaseSync | null = null;
  try {
    database = new DatabaseSync(databasePath, { readOnly: true });
    const rows = database
      .prepare(`SELECT created_at FROM ${MIGRATIONS_TABLE}`)
      .all();
    if (rows.length === 0) return false;
    const applied = new Set(rows.map((row) => Number(row.created_at)));
    return ALEPH_FORK_MIGRATION_WHENS.some((when) => !applied.has(when));
  } catch {
    return false;
  } finally {
    database?.close();
  }
}

function hasStockRuntimeFile(dataDir: string): boolean {
  const runtimePath = formatBbAppRuntimeFilePath(dataDir);
  if (!existsSync(runtimePath)) return false;
  try {
    const parsed: unknown = JSON.parse(readFileSync(runtimePath, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return true;
    const version: unknown = Reflect.get(parsed, "version");
    if (typeof version !== "string") return true;
    return !isAlephAppVersion(version) && version !== DEV_APP_VERSION;
  } catch {
    return true;
  }
}

export function findAlephDataDirRefusal(
  args: AlephDataDirCheckArgs,
): AlephDataDirRefusal | null {
  const dataDir = realpathWithMissingTail(args.dataDir);
  const stock = stockDirectories(args.homeDir).find((parent) =>
    isInside({ child: dataDir, parent }),
  );
  if (stock !== undefined) {
    return {
      reason: "inside_stock_bb_dir",
      detail: `resolves to ${dataDir}, inside ${stock}`,
    };
  }
  if (hasStockMigrationHistory(dataDir)) {
    return {
      reason: "stock_bb_database",
      detail: "its bb.db journal lacks the Aleph fork migrations 0132 and 0133",
    };
  }
  if (hasStockRuntimeFile(dataDir)) {
    return {
      reason: "stock_bb_runtime_file",
      detail: "it holds a stock bb runtime file (bb-app-runtime.json)",
    };
  }
  return null;
}

export function assertAlephDataDir(args: AlephDataDirCheckArgs): void {
  const refusal = findAlephDataDirRefusal(args);
  if (refusal !== null) throw new AlephDataDirRefusedError(args.dataDir, refusal);
}
