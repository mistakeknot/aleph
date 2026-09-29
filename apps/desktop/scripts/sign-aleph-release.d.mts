import type { BuildReceipt } from "./aleph-build-receipt.mjs";
import type { CommandRunner } from "./verify-aleph-release.mjs";

export type NotaryRecord = {
  status: string;
  submission_id: string;
  target: "app" | "dmg";
};
export type SignedArtifactReceipt = {
  build_receipt_digest: string;
  bundle_id: string;
  dmg: { file: string; sha256: string; size: number };
  entitlements_sha256: string;
  notary: NotaryRecord[];
  receipt_id: string;
  schema: "aleph-signed-artifact-receipt/1";
  source_sha: string;
  team_id: string;
  version: string;
  zip: { file: string; sha256: string; size: number };
};
export function signAlephRelease(options: {
  appPath: string;
  buildReceipt: BuildReceipt;
  entitlementsPath: string;
  inheritEntitlementsPath: string;
  keychainPath?: string;
  outputDirectory: string;
  runner: CommandRunner;
  expectedModuleSetSha256: string | undefined;
  signerDirectory?: string;
  signerPath?: string;
}): Promise<{ receipt: SignedArtifactReceipt; receiptPath: string }>;
export function computeSignerModuleSetDigest(
  directory?: string,
): Promise<string>;
