import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { legacyMigrationChain } from "./legacy-migration-chain.js";
import {
  loadMigrationPlan,
  planStepPath,
  type MigrationPlanFolders,
} from "./migration-plan.js";

interface JournalEntry {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
}

function digest(parts: readonly string[]): string {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(`${part.length}:${part}`);
  return hash.digest("hex").slice(0, 24);
}

function isPrivateEntry(path: string, kind: "directory" | "file"): boolean {
  const stat = lstatSync(path);
  if (kind === "directory" ? !stat.isDirectory() : !stat.isFile()) return false;
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    return false;
  }
  return (stat.mode & 0o022) === 0;
}

function isTrustedCachedFolder(
  target: string,
  journal: string,
  files: ReadonlyArray<{ entry: JournalEntry; sql: string }>,
): boolean {
  try {
    const journalPath = join(target, "meta", "_journal.json");
    if (
      !isPrivateEntry(target, "directory") ||
      !isPrivateEntry(join(target, "meta"), "directory") ||
      !isPrivateEntry(journalPath, "file") ||
      readFileSync(journalPath, "utf8") !== journal
    ) {
      return false;
    }
    return files.every((file) => {
      const path = join(target, `${file.entry.tag}.sql`);
      return (
        isPrivateEntry(path, "file") && readFileSync(path, "utf8") === file.sql
      );
    });
  } catch {
    return false;
  }
}

function writeFolder(
  directory: string,
  journal: string,
  files: ReadonlyArray<{ entry: JournalEntry; sql: string }>,
): void {
  mkdirSync(join(directory, "meta"), { recursive: true, mode: 0o700 });
  writeFileSync(join(directory, "meta", "_journal.json"), journal, {
    mode: 0o600,
  });
  for (const file of files) {
    writeFileSync(join(directory, `${file.entry.tag}.sql`), file.sql, {
      mode: 0o600,
    });
  }
}

export function materializeLegacyCompatibleFolder(
  folders: MigrationPlanFolders,
  cacheRoot: string = tmpdir(),
): string {
  const plan = loadMigrationPlan(folders);
  if (plan.steps.length !== legacyMigrationChain.length) {
    throw new Error(
      `Migration plan has ${plan.steps.length} steps but the legacy chain has ${legacyMigrationChain.length}`,
    );
  }
  const files: Array<{ entry: JournalEntry; sql: string }> = [];
  for (const [index, step] of plan.steps.entries()) {
    const legacy = legacyMigrationChain[index];
    if (
      legacy === undefined ||
      legacy.target.namespace !== step.namespace ||
      legacy.target.id !== step.id
    ) {
      throw new Error(
        `Plan step ${step.namespace}:${step.id} does not match legacy entry ${legacy?.idx ?? index} (${legacy?.target.namespace}:${legacy?.target.id})`,
      );
    }
    const sql = readFileSync(planStepPath(folders, step), "utf8");
    if (
      createHash("sha256").update(sql).digest("hex") !== legacy.sha256 ||
      step.sha256 !== legacy.sha256
    ) {
      throw new Error(
        `Plan step ${step.id} does not match the legacy hash for ${legacy.tag}`,
      );
    }
    files.push({
      entry: {
        idx: legacy.idx,
        version: "6",
        when: legacy.when,
        tag: legacy.tag,
        breakpoints: true,
      },
      sql,
    });
  }

  const journal = JSON.stringify(
    {
      version: "7",
      dialect: "sqlite",
      entries: files.map((file) => file.entry),
    },
    null,
    2,
  );
  const key = digest([journal, ...files.map((file) => file.sql)]);
  const target = join(cacheRoot, `bb-migrations-${key}`);
  if (isTrustedCachedFolder(target, journal, files)) return target;

  const staging = mkdtempSync(join(cacheRoot, "bb-migrations-staging-"));
  writeFolder(staging, journal, files);
  if (existsSync(target)) return staging;
  try {
    renameSync(staging, target);
  } catch {
    return isTrustedCachedFolder(target, journal, files) ? target : staging;
  }
  return target;
}
