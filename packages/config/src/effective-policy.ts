import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

const ALEPH_UPDATE_STATE_FILE_NAME = "update-state.json";
const USER_DATA_UPDATE_STATE_FILE_NAME = "aleph-update-state.json";

const derivedPolicySchema = z.strictObject({
  disabled_features: z.array(z.string()),
  floor_seq: z.number().int().nonnegative(),
  install_state: z.string(),
  notice: z.string().nullable(),
  release: z.json().nullable(),
  revoked_key_ids: z.array(z.string()),
  skip_versions: z.array(z.string()),
});

export type DerivedPolicy = z.infer<typeof derivedPolicySchema>;

export const policyCopySchema = z.strictObject({
  derived: derivedPolicySchema,
  epoch: z.number().int().nonnegative(),
  head_bytes: z.string(),
  semantic_sha256: z.string(),
  sig_bytes: z.string(),
  signing_key_id: z.string(),
});

export type PolicyCopy = z.infer<typeof policyCopySchema>;

const mirrorFileSchema = policyCopySchema.extend({
  checksum: z.string(),
  derived_sha256: z.string(),
});

export interface PolicyVerifier {
  derive(copy: PolicyCopy): DerivedPolicy | null;
  verify(copy: PolicyCopy): boolean;
}

export type PolicyCopySlot = "db" | "userData" | "home";

export interface PolicyCopies {
  db: PolicyCopy | null;
  home: PolicyCopy | null;
  userData: PolicyCopy | null;
}

export type EffectivePolicyStatus =
  | "uninitialized"
  | "consistent"
  | "inconsistent"
  | "reenroll_required";

export interface EffectivePolicy {
  authoritative: PolicyCopy | null;
  disabled_features: string[];
  failClosed: boolean;
  revoked_key_ids: string[];
  status: EffectivePolicyStatus;
}

export interface EffectivePolicyArgs {
  copies: PolicyCopies;
  invalidSlots?: ReadonlySet<PolicyCopySlot>;
  verifier: PolicyVerifier;
}

const SLOTS: readonly PolicyCopySlot[] = ["db", "userData", "home"];

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function computeDerivedSha256(derived: DerivedPolicy): string {
  return sha256(derived);
}

export function computeMirrorChecksum(
  body: Omit<z.infer<typeof mirrorFileSchema>, "checksum">,
): string {
  return sha256(body);
}

export function formatAlephUpdateStatePath(dataDir: string): string {
  return join(dataDir, ALEPH_UPDATE_STATE_FILE_NAME);
}

export function formatUserDataUpdateStatePath(userDataDir: string): string {
  return join(userDataDir, USER_DATA_UPDATE_STATE_FILE_NAME);
}

function sortedUnion(lists: readonly (readonly string[])[]): string[] {
  return [...new Set(lists.flat())].sort();
}

function sameDerived(a: DerivedPolicy, b: DerivedPolicy): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

export function effectivePolicy(args: EffectivePolicyArgs): EffectivePolicy {
  const present = SLOTS.flatMap((slot) => {
    const copy = args.copies[slot];
    return copy === null ? [] : [{ copy, slot }];
  });
  const disabled_features = sortedUnion(
    present.map((entry) => entry.copy.derived.disabled_features),
  );
  const revoked_key_ids = sortedUnion(
    present.map((entry) => entry.copy.derived.revoked_key_ids),
  );
  if (present.length === 0) {
    return {
      authoritative: null,
      disabled_features,
      failClosed: false,
      revoked_key_ids,
      status: "uninitialized",
    };
  }
  const revoked = new Set(revoked_key_ids);
  const valid = present.filter(
    (entry) =>
      args.invalidSlots?.has(entry.slot) !== true &&
      !revoked.has(entry.copy.signing_key_id) &&
      args.verifier.verify(entry.copy),
  );
  const authoritative =
    valid.reduce<(typeof valid)[number] | null>(
      (best, entry) =>
        best === null || entry.copy.epoch > best.copy.epoch ? entry : best,
      null,
    )?.copy ?? null;
  if (authoritative === null) {
    return {
      authoritative: null,
      disabled_features,
      failClosed: true,
      revoked_key_ids,
      status: "reenroll_required",
    };
  }
  const first = args.copies.db;
  const consistent =
    valid.length === SLOTS.length &&
    first !== null &&
    present.every(({ copy }) => {
      if (
        copy.epoch !== first.epoch ||
        copy.semantic_sha256 !== first.semantic_sha256
      ) {
        return false;
      }
      const rederived = args.verifier.derive(copy);
      return rederived !== null && sameDerived(rederived, copy.derived);
    });
  if (consistent) {
    return {
      authoritative,
      disabled_features: [...first.derived.disabled_features].sort(),
      failClosed: false,
      revoked_key_ids: [...first.derived.revoked_key_ids].sort(),
      status: "consistent",
    };
  }
  return {
    authoritative,
    disabled_features,
    failClosed: true,
    revoked_key_ids,
    status: "inconsistent",
  };
}

interface MirrorRead {
  copy: PolicyCopy | null;
  invalid: boolean;
}

function readMirror(path: string): MirrorRead {
  let parsed: z.infer<typeof mirrorFileSchema>;
  try {
    parsed = mirrorFileSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return { copy: null, invalid: false };
  }
  const { checksum, ...body } = parsed;
  const { derived_sha256, ...copy } = body;
  const intact =
    checksum === computeMirrorChecksum(body) &&
    derived_sha256 === computeDerivedSha256(copy.derived);
  return { copy, invalid: !intact };
}

export interface LoadEffectivePolicyArgs {
  dataDir: string;
  readDatabaseCopy: () => PolicyCopy | null;
  userDataDir: string | null;
  verifier: PolicyVerifier;
}

export function loadEffectivePolicy(
  args: LoadEffectivePolicyArgs,
): EffectivePolicy {
  let db: PolicyCopy | null = null;
  try {
    db = args.readDatabaseCopy();
  } catch {
    db = null;
  }
  const home = readMirror(formatAlephUpdateStatePath(args.dataDir));
  const userData =
    args.userDataDir === null
      ? { copy: null, invalid: false }
      : readMirror(formatUserDataUpdateStatePath(args.userDataDir));
  const invalidSlots = new Set<PolicyCopySlot>();
  if (home.invalid) invalidSlots.add("home");
  if (userData.invalid) invalidSlots.add("userData");
  return effectivePolicy({
    copies: { db, home: home.copy, userData: userData.copy },
    invalidSlots,
    verifier: args.verifier,
  });
}

export const failClosedPolicyVerifier: PolicyVerifier = {
  derive: () => null,
  verify: () => false,
};

export function formatPluginPolicyFeature(pluginId: string): string {
  return `plugin:${pluginId}`;
}

export interface PluginPolicyGateArgs {
  dataDir: string;
  pluginId: string;
  readDatabaseCopy: () => PolicyCopy | null;
  userDataDir: string | null;
  verifier: PolicyVerifier;
}

export function pluginPolicyDisabledDetail(
  args: PluginPolicyGateArgs,
): string | null {
  const policy = loadEffectivePolicy(args);
  return policy.disabled_features.includes(
    formatPluginPolicyFeature(args.pluginId),
  )
    ? `plugin ${args.pluginId} is disabled by Aleph update policy`
    : null;
}

export const ALEPH_USER_DATA_DIR_ENV_NAME = "ALEPH_USER_DATA_DIR";

export function resolveAlephUserDataDir(env: NodeJS.ProcessEnv): string | null {
  const value = env[ALEPH_USER_DATA_DIR_ENV_NAME]?.trim();
  return value === undefined || value.length === 0 ? null : value;
}
