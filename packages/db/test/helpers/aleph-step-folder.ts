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
  manifest.steps.push({
    id: "A0010",
    file: "A0010_synthetic.sql",
    after: last.id,
    when: last.when + 1000,
  });
  writeFileSync(manifestPath, JSON.stringify(manifest));
  writeFileSync(join(folder, "A0010_synthetic.sql"), sql);
  if (checks !== undefined) {
    const checksPath = join(folder, "step-checks.json");
    const existing = JSON.parse(readFileSync(checksPath, "utf8")) as object;
    writeFileSync(checksPath, JSON.stringify({ ...existing, A0010: checks }));
  }
  return folder;
}
