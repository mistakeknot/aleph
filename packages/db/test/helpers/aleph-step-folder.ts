import { loadMigrationPlan } from "../../src/migration-plan.js";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sourceFolders } from "./plan-apply.js";

export function alephFolderWithSyntheticStep(
  sql: string,
  checks?: object,
): string {
  const folder = mkdtempSync(join(tmpdir(), "bb-synthetic-aleph-"));
  cpSync(sourceFolders.alephFolder, folder, { recursive: true });
  const manifestPath = join(folder, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    steps: Array<{ id: string; file: string; after: string; when: number }>;
  };
  const last = manifest.steps[manifest.steps.length - 1];
  if (last === undefined) throw new Error("Manifest is empty");
  const journal = JSON.parse(
    readFileSync(
      join(sourceFolders.upstreamFolder, "meta/_journal.json"),
      "utf8",
    ),
  ) as { entries: Array<{ tag: string; when: number }> };
  const lastUpstream = journal.entries[journal.entries.length - 1];
  if (lastUpstream === undefined) throw new Error("Journal is empty");
  manifest.steps.push({
    id: "A0017",
    file: "A0017_synthetic.sql",
    after:
      last.when >= loadMigrationPlan(sourceFolders).steps.at(-1)!.when
        ? last.id
        : loadMigrationPlan(sourceFolders).steps.at(-1)!.id,
    when: Math.max(last.when, lastUpstream.when) + 1000,
  });
  writeFileSync(manifestPath, JSON.stringify(manifest));
  writeFileSync(join(folder, "A0017_synthetic.sql"), sql);
  if (checks !== undefined) {
    const checksPath = join(folder, "step-checks.json");
    const existing = JSON.parse(readFileSync(checksPath, "utf8")) as object;
    writeFileSync(checksPath, JSON.stringify({ ...existing, A0017: checks }));
  }
  return folder;
}
