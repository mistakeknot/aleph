import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
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

export function materializeLegacyCompatibleFolder(
  folders: MigrationPlanFolders,
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
  const target = join(tmpdir(), `bb-migrations-${key}`);
  if (existsSync(join(target, "meta", "_journal.json"))) return target;

  const staging = `${target}.${process.pid}.${Date.now()}`;
  mkdirSync(join(staging, "meta"), { recursive: true });
  writeFileSync(join(staging, "meta", "_journal.json"), journal);
  for (const file of files) {
    writeFileSync(join(staging, `${file.entry.tag}.sql`), file.sql);
  }
  try {
    renameSync(staging, target);
  } catch (error) {
    rmSync(staging, { force: true, recursive: true });
    if (!existsSync(join(target, "meta", "_journal.json"))) throw error;
  }
  return target;
}
