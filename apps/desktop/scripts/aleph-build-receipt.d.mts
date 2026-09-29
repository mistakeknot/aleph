export type BuildReceipt = {
  artifact_digest: string;
  lockfile_digest: string;
  recipe_digest: string;
  repo_id: string;
  schema: "aleph-build-receipt/1";
  source_sha: string;
  tool_versions: Record<string, string>;
  version: string;
};
export function digestTree(path: string): Promise<string>;
export function digestFile(path: string): Promise<string>;
export function canonicalJson(value: unknown): string;
export function createBuildReceipt(options: {
  appPath: string;
  lockfilePath: string;
  recipePaths: string[];
  repoId: string;
  sourceSha: string;
  toolVersions: Record<string, string>;
  version: string;
}): Promise<BuildReceipt>;
