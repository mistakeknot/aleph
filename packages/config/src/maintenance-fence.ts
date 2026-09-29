import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { alephReleaseIdentity } from "./aleph-version.js";
import { acquireDataDirLock, type DataDirLockHolder } from "./data-dir-lock.js";

const MAINTENANCE_FENCE_FILE_NAME = "maintenance.json";
const DATABASE_FILE_NAMES = ["bb.db"] as const;
export const FENCE_REFUSED_EXIT_CODE = 75;

export const MAINTENANCE_FENCE_STATES = [
  "installing",
  "probation",
  "recovering",
] as const;
export type MaintenanceFenceState = (typeof MAINTENANCE_FENCE_STATES)[number];

const maintenanceFenceSchema = z.strictObject({
  state: z.enum(MAINTENANCE_FENCE_STATES),
  enrolled_path: z.string(),
  from_version: z.string(),
  to_version: z.string(),
  from_bundle_version: z.string(),
  to_bundle_version: z.string(),
  from_cdhash: z.string(),
  to_cdhash: z.string(),
  from_tree_sha256: z.string(),
  to_tree_sha256: z.string(),
  predecessor_path: z.string(),
  created_at: z.string(),
  nonce: z.string(),
  observation: z.json().nullable(),
});

export type MaintenanceFence = z.infer<typeof maintenanceFenceSchema>;

const fenceFileSchema = z.strictObject({
  fence: maintenanceFenceSchema,
  checksum: z.string(),
});

export type MaintenanceFenceRead =
  | { status: "absent" }
  | { status: "present"; fence: MaintenanceFence }
  | { status: "corrupt"; reason: string };

export const FENCE_PROCESS_ROLES = [
  "desktop-main",
  "embedded-server",
  "bundled-daemon",
  "cli",
  "plugin-worker",
] as const;
export type FenceProcessRole = (typeof FENCE_PROCESS_ROLES)[number];

export interface FenceIdentity {
  role: FenceProcessRole;
  version: string;
}

export type MaintenanceFenceDecision =
  | { kind: "allow" }
  | { kind: "advance_to_probation" }
  | {
      kind: "refuse";
      exitCode: typeof FENCE_REFUSED_EXIT_CODE;
      message: string;
      retryable: boolean;
    };

export type MaintenanceFenceRefusal = Extract<
  MaintenanceFenceDecision,
  { kind: "refuse" }
>;

export class MaintenanceFenceRefusedError extends Error {
  readonly exitCode = FENCE_REFUSED_EXIT_CODE;
  constructor(readonly refusal: MaintenanceFenceRefusal) {
    super(refusal.message);
  }
}

const PROBATION_BUNDLED_ROLES: readonly FenceProcessRole[] = [
  "desktop-main",
  "embedded-server",
  "bundled-daemon",
  "plugin-worker",
];

export function formatMaintenanceFencePath(dataDir: string): string {
  return join(dataDir, MAINTENANCE_FENCE_FILE_NAME);
}

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

function fenceChecksum(fence: MaintenanceFence): string {
  return createHash("sha256").update(canonicalJson(fence)).digest("hex");
}

function fsyncDirectory(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function writeMaintenanceFence(args: {
  dataDir: string;
  fence: MaintenanceFence;
}): void {
  const target = formatMaintenanceFencePath(args.dataDir);
  const temp = `${target}.${randomUUID()}.tmp`;
  const body = `${JSON.stringify({ fence: args.fence, checksum: fenceChecksum(args.fence) })}\n`;
  const fd = openSync(temp, "w", 0o600);
  try {
    writeSync(fd, body);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, target);
  fsyncDirectory(args.dataDir);
}

export function readMaintenanceFence(dataDir: string): MaintenanceFenceRead {
  let raw: string;
  try {
    raw = readFileSync(formatMaintenanceFencePath(dataDir), "utf8");
  } catch (error) {
    if (error instanceof Error && Reflect.get(error, "code") === "ENOENT") {
      return { status: "absent" };
    }
    return { status: "corrupt", reason: "the fence file could not be read" };
  }
  let parsed: z.infer<typeof fenceFileSchema>;
  try {
    parsed = fenceFileSchema.parse(JSON.parse(raw));
  } catch {
    return { status: "corrupt", reason: "the fence file is malformed" };
  }
  if (fenceChecksum(parsed.fence) !== parsed.checksum) {
    return { status: "corrupt", reason: "the fence checksum does not match" };
  }
  return { status: "present", fence: parsed.fence };
}

function refuse(message: string, retryable: boolean): MaintenanceFenceRefusal {
  return {
    exitCode: FENCE_REFUSED_EXIT_CODE,
    kind: "refuse",
    message,
    retryable,
  };
}

function decideForFence(
  fence: MaintenanceFence,
  identity: FenceIdentity,
): MaintenanceFenceDecision {
  const version = alephReleaseIdentity(identity.version);
  if (fence.state === "recovering") {
    return refuse(
      "Aleph is recovering from a failed update. Try again shortly.",
      true,
    );
  }
  if (version === alephReleaseIdentity(fence.from_version)) {
    return refuse(
      fence.state === "installing"
        ? "Aleph is updating. Try again once the update finishes."
        : `Aleph was updated; open it from ${fence.enrolled_path}`,
      fence.state === "installing",
    );
  }
  if (version !== alephReleaseIdentity(fence.to_version)) {
    return refuse(
      `Aleph was updated; open it from ${fence.enrolled_path}`,
      false,
    );
  }
  if (fence.state === "installing") {
    return identity.role === "desktop-main"
      ? { kind: "advance_to_probation" }
      : refuse("Aleph is updating. Try again once the update finishes.", true);
  }
  if (PROBATION_BUNDLED_ROLES.includes(identity.role)) return { kind: "allow" };
  return refuse("Aleph is checking a new update. Try again in a moment.", true);
}

export function checkMaintenanceFence(args: {
  dataDir: string;
  identity: FenceIdentity;
}): MaintenanceFenceDecision {
  const read = readMaintenanceFence(args.dataDir);
  if (read.status === "absent") return { kind: "allow" };
  if (read.status === "corrupt") {
    return refuse(
      `Aleph cannot verify its update state (${read.reason}). Run \`bb aleph recover --report\` and contact support.`,
      false,
    );
  }
  return decideForFence(read.fence, args.identity);
}

export function enforceMaintenanceFence(args: {
  dataDir: string;
  identity: FenceIdentity;
}): MaintenanceFenceDecision {
  const decision = checkMaintenanceFence(args);
  if (decision.kind === "refuse")
    throw new MaintenanceFenceRefusedError(decision);
  registerFenceIdentity(args.identity);
  return decision;
}

export async function advanceFenceToProbation(args: {
  dataDir: string;
  holder: DataDirLockHolder;
  timeoutMs: number;
}): Promise<void> {
  const lock = await acquireDataDirLock({
    dataDir: args.dataDir,
    holder: args.holder,
    mode: "exclusive",
    timeoutMs: args.timeoutMs,
  });
  try {
    const read = readMaintenanceFence(args.dataDir);
    if (read.status !== "present" || read.fence.state !== "installing") {
      throw new Error("The maintenance fence is not in the installing state");
    }
    writeMaintenanceFence({
      dataDir: args.dataDir,
      fence: { ...read.fence, state: "probation" },
    });
  } finally {
    await lock.release();
  }
}

let registeredIdentity: FenceIdentity | null = null;

export function registerFenceIdentity(identity: FenceIdentity): void {
  registeredIdentity = identity;
}

export function resetFenceIdentityForTests(): void {
  registeredIdentity = null;
}

export function assertFenceAllowsDatabase(databasePath: string): void {
  const dataDir = fenceDirectoryForDatabase(databasePath);
  if (dataDir === null) return;
  assertFenceAllowsDataDir(dataDir);
}

export function assertFenceAllowsDataDir(dataDir: string): void {
  const read = readMaintenanceFence(dataDir);
  if (read.status === "absent") return;
  const decision =
    registeredIdentity === null
      ? refuse(
          "Aleph is updating. This process has not passed the maintenance fence check.",
          true,
        )
      : checkMaintenanceFence({ dataDir, identity: registeredIdentity });
  if (decision.kind === "refuse")
    throw new MaintenanceFenceRefusedError(decision);
}

function fenceDirectoryForDatabase(databasePath: string): string | null {
  if (databasePath === ":memory:" || databasePath === "") return null;
  const lastSeparator = Math.max(
    databasePath.lastIndexOf("/"),
    databasePath.lastIndexOf("\\"),
  );
  if (lastSeparator < 0) return ".";
  const name = databasePath.slice(lastSeparator + 1);
  return DATABASE_FILE_NAMES.some((databaseName) => databaseName === name) ||
    name.endsWith(".db")
    ? databasePath.slice(0, lastSeparator) || "/"
    : null;
}
