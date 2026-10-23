import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate as drizzleMigrate } from "drizzle-orm/better-sqlite3/migrator";
import type { DbConnection } from "../../src/connection.js";
import type { MigrateOptions } from "../../src/migrate.js";

export const LEGACY_ORACLE_COMMIT = "1c201c2f57";
export const UPSTREAM_ORACLE_COMMIT =
  "411eac54ac16d0a3cb57d1de8396d37564884a73";
export const LEGACY_CHAIN_LENGTH = 153;

const here = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(here, "..", "..");
const oracleRoot = join(packageDir, ".legacy-oracle");
const oraclePackageDir = join(oracleRoot, "packages", "db");
const stampPath = join(oracleRoot, "COMMIT");
const stamp = `${LEGACY_ORACLE_COMMIT} ${UPSTREAM_ORACLE_COMMIT}`;

export const legacyDrizzleFolder = join(oraclePackageDir, "drizzle");
export const upstreamDrizzleFolder = join(
  oracleRoot,
  "upstream",
  "packages",
  "db",
  "drizzle",
);

interface LegacyModules {
  createConnection: (path: string) => DbConnection;
  migrate: (db: DbConnection, options?: MigrateOptions) => void;
}

let loaded: Promise<LegacyModules> | undefined;

function repoRootOf(): string {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: packageDir,
    encoding: "utf8",
  }).trim();
}

interface OracleTree {
  commit: string;
  paths: string[];
  destination: string;
}

function oracleTrees(): OracleTree[] {
  return [
    {
      commit: LEGACY_ORACLE_COMMIT,
      paths: ["packages/db/src", "packages/db/drizzle"],
      destination: oracleRoot,
    },
    {
      commit: UPSTREAM_ORACLE_COMMIT,
      paths: ["packages/db/drizzle"],
      destination: join(oracleRoot, "upstream"),
    },
  ];
}

function listFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
}

function cacheMatchesGit(repoRoot: string): boolean {
  for (const tree of oracleTrees()) {
    const entries = execFileSync(
      "git",
      ["ls-tree", "-r", "-z", tree.commit, "--", ...tree.paths],
      { cwd: repoRoot, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
    )
      .split("\0")
      .filter(Boolean)
      .map((line) => {
        const [meta, path = ""] = line.split("\t");
        return { blob: meta?.split(" ")[2] ?? "", path };
      });
    const onDisk = tree.paths.flatMap((path) =>
      listFiles(join(tree.destination, path)),
    );
    if (onDisk.length !== entries.length) return false;
    const absolute = entries.map((entry) => join(tree.destination, entry.path));
    if (!absolute.every((path) => existsSync(path))) return false;
    const hashes = execFileSync("git", ["hash-object", "--stdin-paths"], {
      cwd: repoRoot,
      encoding: "utf8",
      input: `${absolute.join("\n")}\n`,
      maxBuffer: 256 * 1024 * 1024,
    })
      .trim()
      .split("\n");
    if (!entries.every((entry, index) => hashes[index] === entry.blob))
      return false;
  }
  return true;
}

let verified = false;

export function materializeLegacyOracle(): void {
  if (verified) return;
  const repoRoot = repoRootOf();
  if (
    existsSync(stampPath) &&
    readFileSync(stampPath, "utf8").trim() === stamp &&
    cacheMatchesGit(repoRoot)
  ) {
    verified = true;
    return;
  }
  rmSync(oracleRoot, { recursive: true, force: true });
  mkdirSync(oracleRoot, { recursive: true });
  for (const tree of oracleTrees()) {
    mkdirSync(tree.destination, { recursive: true });
    execFileSync("tar", ["-x", "-C", tree.destination], {
      input: execFileSync("git", ["archive", tree.commit, ...tree.paths], {
        cwd: repoRoot,
        maxBuffer: 256 * 1024 * 1024,
      }),
    });
  }
  if (!cacheMatchesGit(repoRoot))
    throw new Error("Materialised legacy oracle does not match git");
  writeFileSync(stampPath, `${stamp}\n`);
  verified = true;
}

export function loadLegacyRunner(): Promise<LegacyModules> {
  loaded ??= (async () => {
    materializeLegacyOracle();
    const connection = (await import(
      pathToFileURL(join(oraclePackageDir, "src", "connection.ts")).href
    )) as { createConnection: LegacyModules["createConnection"] };
    const migration = (await import(
      pathToFileURL(join(oraclePackageDir, "src", "migrate.ts")).href
    )) as { migrate: LegacyModules["migrate"] };
    return {
      createConnection: connection.createConnection,
      migrate: migration.migrate,
    };
  })();
  return loaded;
}

interface JournalFile {
  version: string;
  dialect: string;
  entries: Array<{ idx: number; tag: string; when: number }>;
}

export function buildTruncatedFolder(length: number): string {
  materializeLegacyOracle();
  const journal = JSON.parse(
    readFileSync(join(legacyDrizzleFolder, "meta", "_journal.json"), "utf8"),
  ) as JournalFile;
  const folder = mkdtempSync(join(tmpdir(), "bb-prefix-folder-"));
  mkdirSync(join(folder, "meta"));
  const entries = journal.entries.slice(0, length);
  for (const entry of entries)
    cpSync(
      join(legacyDrizzleFolder, `${entry.tag}.sql`),
      join(folder, `${entry.tag}.sql`),
    );
  writeFileSync(
    join(folder, "meta", "_journal.json"),
    JSON.stringify({ ...journal, entries }),
  );
  return folder;
}

export function applyFolder(sqlite: Database.Database, folder: string): void {
  sqlite.pragma("foreign_keys = OFF");
  sqlite.exec(
    "CREATE TEMP TABLE IF NOT EXISTS bb_migration_existing_installation (existing INTEGER NOT NULL); DELETE FROM bb_migration_existing_installation; INSERT INTO bb_migration_existing_installation (existing) VALUES (0); CREATE TEMP TABLE IF NOT EXISTS bb_migration_local_host (id TEXT PRIMARY KEY); DELETE FROM bb_migration_local_host; CREATE TEMP TABLE IF NOT EXISTS bb_migration_queued_message_groups (id TEXT PRIMARY KEY, group_with_next INTEGER NOT NULL); DELETE FROM bb_migration_queued_message_groups",
  );
  drizzleMigrate(drizzle(sqlite), { migrationsFolder: folder });
}

export function applyPrefix(sqlite: Database.Database, length: number): void {
  const folder = buildTruncatedFolder(length);
  try {
    applyFolder(sqlite, folder);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

export function openRawDatabase(): Database.Database {
  return new Database(":memory:");
}
