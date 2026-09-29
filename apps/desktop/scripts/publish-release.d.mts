import type { SignedArtifactReceipt } from "./sign-aleph-release.mjs";
import type { CommandRunner } from "./verify-aleph-release.mjs";

export type GithubRelease = {
  assets: {
    digest?: string;
    id: number;
    name: string;
    size: number;
    url: string;
  }[];
  draft: boolean;
  id: number;
  tag: string;
};
export type GithubClient = {
  downloadDraftAsset(options: {
    assetId: number;
    name: string;
  }): Promise<Buffer>;
  getReleaseById(id: number): Promise<GithubRelease>;
  fetchPublicAsset(url: string): Promise<Buffer>;
  getRelease(tag: string): Promise<GithubRelease>;
  setDraft(id: number, draft: boolean): Promise<void>;
};
export function createGhClient(options: {
  env?: Record<string, string | undefined>;
  repository: string;
  runner: CommandRunner;
}): GithubClient;
export function publishAlephRelease(options: {
  approvalPath: string;
  dmgPath: string;
  env: Record<string, string | undefined>;
  expectedSignersSha256: string | undefined;
  github: GithubClient;
  now: Date;
  receipt: SignedArtifactReceipt;
  runner: CommandRunner;
  signersPath?: string;
  zipPath: string;
}): Promise<{ approvalId: string; tag: string }>;
