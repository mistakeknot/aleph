import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import fsSync, { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import type { FileHandle } from "node:fs/promises";
import type { HostDaemonOnlineRpcResult } from "@bb/host-daemon-contract";
import { z } from "zod";
import type { CommandOf } from "../command-dispatch-support.js";
import { isFsErrorWithCode } from "../fs-errors.js";
import { runInSerialLane } from "../serial-lane.js";
import { sha256Hex } from "../sha256-hex.js";
import {
  assertNoDuplicateAssignments,
  assertReconcilable,
  reconcileDotenv,
} from "./secret-dotenv.js";

export const DEFAULT_SECRET_ALLOWLIST_PATH = "/etc/home-secrets/allowlist.json";
const ALLOWLIST_MAX_BYTES = 1024 * 1024;
const DOTENV_MAX_BYTES = 1024 * 1024;

const CREDENTIAL_STORE_PREFIXES: readonly (readonly string[])[] = [
  [".ssh"],
  [".claude"],
  [".codex"],
  [".gnupg"],
  [".aws"],
  [".kube"],
  [".docker"],
  [".netrc"],
  [".npmrc"],
  [".pypirc"],
  [".config", "gh"],
  [".config", "jev"],
  [".config", "bb"],
  [".config", "gcloud"],
  [".local", "share", "keyrings"],
  [".bb"],
  [".bb-machines"],
];

export const SECRET_REFUSAL_MESSAGES = {
  "invalid-request": "The secret request is malformed.",
  expired: "The secret request has expired.",
  "path-not-normalized":
    "The destination path must be absolute and normalized.",
  "outside-home": "The destination is outside the home directory.",
  "credential-store": "The destination is inside a credential store.",
  "allowlist-unavailable": "The secrets allowlist could not be read.",
  "allowlist-untrusted":
    "The secrets allowlist is not root-owned and write-protected.",
  "not-allowlisted":
    "The project, path and names do not match one allowlist entry.",
  "symlink-in-path": "The destination path contains a symlink.",
  "parent-missing": "The destination directory does not exist.",
  "parent-ownership":
    "The destination directory must be owned by the writing user with mode 0700.",
  "file-ownership":
    "The destination file must be a regular file owned by the writing user with mode 0600.",
  "unreconcilable-file":
    "The destination file cannot be updated safely (duplicate names or unsupported content).",
  "digest-mismatch": "The request no longer matches the approved request.",
  "identity-changed": "The destination changed since it was checked.",
  "target-appeared": "A file appeared at the destination after it was checked.",
  "allowlist-changed": "The allowlist entry changed since it was checked.",
  "internal-error": "The secret write failed.",
} as const;

export type SecretRefusalReason = keyof typeof SECRET_REFUSAL_MESSAGES;

export type SecretCommitStep =
  | "parent-open"
  | "target-read"
  | "tmp-written"
  | "pre-rename-check"
  | "renamed"
  | "verified";

export interface SecretWriterConfig {
  allowlistPath: string;
  allowlistOwnerUid: number;
  homeDir: string;
  trustedUid: number;
  now: () => number;
  afterStep?: (step: SecretCommitStep) => void | Promise<void>;
  orphanMinAgeMs?: number;
}

type ProbeCommand = CommandOf<"host.secret_probe">;
type CommitCommand = CommandOf<"host.secret_commit">;
type ProbeResult = HostDaemonOnlineRpcResult<"host.secret_probe">;
type CommitResult = HostDaemonOnlineRpcResult<"host.secret_commit">;
type Refused = Extract<ProbeResult, { outcome: "refused" }>;

class SecretRefusal extends Error {
  constructor(readonly reason: SecretRefusalReason) {
    super(SECRET_REFUSAL_MESSAGES[reason]);
  }
}

function refused(reason: SecretRefusalReason): Refused {
  return {
    outcome: "refused",
    reason,
    message: SECRET_REFUSAL_MESSAGES[reason],
  };
}

export type CanonicalValue =
  | string
  | number
  | boolean
  | null
  | readonly CanonicalValue[]
  | { readonly [key: string]: CanonicalValue };

export function canonicalJson(value: CanonicalValue): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new Error("canonicalJson accepts safe integers only");
    }
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${(value as readonly CanonicalValue[]).map(canonicalJson).join(",")}]`;
  }
  const record = value as { readonly [key: string]: CanonicalValue };
  const keys = Object.keys(record).sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key]!)}`)
    .join(",")}}`;
}

const allowlistFileSchema = z
  .object({
    entries: z.array(
      z
        .object({
          project: z.string().min(1),
          path: z.string().min(1),
          names: z.array(z.string().min(1)).min(1),
          consumer: z.string(),
        })
        .strict(),
    ),
  })
  .strict();

interface AllowlistEntry {
  project: string;
  path: string;
  names: string[];
  consumer: string;
}

export function allowlistEntrySha256(entry: AllowlistEntry): string {
  return sha256Hex(
    Buffer.from(
      canonicalJson({
        consumer: entry.consumer,
        names: [...entry.names].sort(),
        path: entry.path,
        project: entry.project,
      }),
      "utf8",
    ),
  );
}

function assertRootOwnedNotWritable(
  stat: fsSync.Stats,
  ownerUid: number,
): void {
  if (stat.uid !== ownerUid || (stat.mode & 0o022) !== 0) {
    throw new SecretRefusal("allowlist-untrusted");
  }
}

async function loadAllowlist(
  config: SecretWriterConfig,
): Promise<AllowlistEntry[]> {
  const dir =
    config.allowlistPath.slice(0, config.allowlistPath.lastIndexOf("/")) || "/";
  let handle: FileHandle | undefined;
  try {
    const dirStat = await fs.lstat(dir);
    if (!dirStat.isDirectory()) throw new SecretRefusal("allowlist-untrusted");
    assertRootOwnedNotWritable(dirStat, config.allowlistOwnerUid);
    handle = await fs.open(
      config.allowlistPath,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > ALLOWLIST_MAX_BYTES) {
      throw new SecretRefusal("allowlist-untrusted");
    }
    assertRootOwnedNotWritable(stat, config.allowlistOwnerUid);
    const text = await handle.readFile({ encoding: "utf8" });
    const parsed = allowlistFileSchema.parse(JSON.parse(text));
    return parsed.entries;
  } catch (error) {
    if (error instanceof SecretRefusal) throw error;
    throw new SecretRefusal("allowlist-unavailable");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

type Binding = Pick<
  ProbeCommand,
  | "requestId"
  | "threadId"
  | "hostId"
  | "project"
  | "path"
  | "fields"
  | "purpose"
  | "expiresAtMs"
>;

function splitAbsolutePath(path: string): string[] {
  if (
    !path.startsWith("/") ||
    path.includes("\0") ||
    path.length > 4096 ||
    path.endsWith("/")
  ) {
    throw new SecretRefusal("path-not-normalized");
  }
  const parts = path.slice(1).split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new SecretRefusal("path-not-normalized");
  }
  if (parts.length < 2) throw new SecretRefusal("path-not-normalized");
  return parts;
}

function checkDestination(
  command: Binding,
  config: SecretWriterConfig,
): { parts: string[]; names: string[] } {
  if (config.now() >= command.expiresAtMs) throw new SecretRefusal("expired");
  const names = command.fields.map((field) => field.name);
  if (new Set(names).size !== names.length) {
    throw new SecretRefusal("invalid-request");
  }
  const parts = splitAbsolutePath(command.path);
  const homeParts = splitAbsolutePath(`${config.homeDir}/x`).slice(0, -1);
  const underHome =
    parts.length > homeParts.length &&
    homeParts.every((part, index) => parts[index] === part);
  if (!underHome) throw new SecretRefusal("outside-home");
  const relative = parts.slice(homeParts.length);
  for (const prefix of CREDENTIAL_STORE_PREFIXES) {
    if (prefix.every((part, index) => relative[index] === part)) {
      throw new SecretRefusal("credential-store");
    }
  }
  return { parts, names };
}

function matchAllowlist(
  entries: readonly AllowlistEntry[],
  command: Binding,
  names: readonly string[],
): AllowlistEntry {
  const entry = entries.find(
    (candidate) =>
      candidate.project === command.project &&
      candidate.path === command.path &&
      names.every((name) => candidate.names.includes(name)),
  );
  if (!entry) throw new SecretRefusal("not-allowlisted");
  return entry;
}

const DIR_FLAGS =
  fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW;

function fdPath(handle: FileHandle, name: string): string {
  return `/proc/self/fd/${handle.fd}/${name}`;
}

async function openDirectoryChain(
  components: readonly string[],
): Promise<{ parent: FileHandle; all: FileHandle[] }> {
  const all: FileHandle[] = [];
  try {
    let current = await fs.open("/", DIR_FLAGS);
    all.push(current);
    for (const component of components) {
      current = await fs.open(fdPath(current, component), DIR_FLAGS);
      all.push(current);
    }
    return { parent: current, all };
  } catch (error) {
    await closeAll(all);
    if (isFsErrorWithCode(error, "ENOENT"))
      throw new SecretRefusal("parent-missing");
    if (
      isFsErrorWithCode(error, "ELOOP") ||
      isFsErrorWithCode(error, "ENOTDIR")
    ) {
      throw new SecretRefusal("symlink-in-path");
    }
    throw error;
  }
}

async function closeAll(handles: readonly FileHandle[]): Promise<void> {
  await Promise.all(
    handles.map((handle) => handle.close().catch(() => undefined)),
  );
}

type Identity = { dev: string; ino: string };

async function identityOf(handle: FileHandle): Promise<Identity> {
  const stat = await handle.stat({ bigint: true });
  return { dev: stat.dev.toString(), ino: stat.ino.toString() };
}

function sameIdentity(a: Identity | null, b: Identity | null): boolean {
  if (a === null || b === null) return a === b;
  return a.dev === b.dev && a.ino === b.ino;
}

async function assertParentTrusted(
  parent: FileHandle,
  config: SecretWriterConfig,
): Promise<void> {
  const stat = await parent.stat();
  if (stat.uid !== config.trustedUid || (stat.mode & 0o777) !== 0o700) {
    throw new SecretRefusal("parent-ownership");
  }
}

async function openTarget(
  parent: FileHandle,
  name: string,
): Promise<FileHandle | null> {
  try {
    return await fs.open(
      fdPath(parent, name),
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
    );
  } catch (error) {
    if (isFsErrorWithCode(error, "ENOENT")) return null;
    if (isFsErrorWithCode(error, "ELOOP"))
      throw new SecretRefusal("file-ownership");
    throw error;
  }
}

async function assertFileTrusted(
  file: FileHandle,
  config: SecretWriterConfig,
): Promise<void> {
  const stat = await file.stat();
  if (
    !stat.isFile() ||
    stat.uid !== config.trustedUid ||
    (stat.mode & 0o777) !== 0o600 ||
    stat.nlink !== 1
  ) {
    throw new SecretRefusal("file-ownership");
  }
}

async function readDotenv(file: FileHandle): Promise<string> {
  const stat = await file.stat();
  if (stat.size > DOTENV_MAX_BYTES)
    throw new SecretRefusal("unreconcilable-file");
  const bytes = await file.readFile();
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return text;
}

function presentNames(content: string, names: readonly string[]): string[] {
  return names.filter((name) =>
    new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=`, "mu").test(content),
  );
}

function computeDigest(args: {
  command: Binding;
  names: readonly string[];
  destRealpath: string;
  parent: Identity;
  file: Identity | null;
  entrySha256: string;
}): string {
  const descriptions: [string, string | null][] = args.command.fields
    .map((field): [string, string | null] => [field.name, field.description])
    .sort((left, right) =>
      left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0,
    );
  return sha256Hex(
    Buffer.from(
      canonicalJson({
        allowlist_entry_sha256: args.entrySha256,
        dest_realpath: args.destRealpath,
        descriptions,
        expires_at: args.command.expiresAtMs,
        file: args.file,
        host_id: args.command.hostId,
        names: [...args.names].sort(),
        parent: args.parent,
        purpose: args.command.purpose,
        request_id: args.command.requestId,
        thread_id: args.command.threadId,
      }),
      "utf8",
    ),
  );
}

export async function probeSecretDestination(
  command: ProbeCommand,
  config: SecretWriterConfig,
): Promise<ProbeResult> {
  const opened: FileHandle[] = [];
  try {
    const { parts, names } = checkDestination(command, config);
    const entry = matchAllowlist(await loadAllowlist(config), command, names);
    const dirParts = parts.slice(0, -1);
    const fileName = parts[parts.length - 1]!;
    const chain = await openDirectoryChain(dirParts);
    opened.push(...chain.all);
    await assertParentTrusted(chain.parent, config);
    await sweepOrphans(chain.parent, config);
    const parentIdentity = await identityOf(chain.parent);
    const target = await openTarget(chain.parent, fileName);
    let fileIdentity: Identity | null = null;
    let existing: string[] = [];
    if (target) {
      opened.push(target);
      await assertFileTrusted(target, config);
      fileIdentity = await identityOf(target);
      let content: string;
      try {
        content = await readDotenv(target);
        assertNoDuplicateAssignments(content, names);
        assertReconcilable(content, names);
      } catch (error) {
        if (error instanceof SecretRefusal) throw error;
        throw new SecretRefusal("unreconcilable-file");
      }
      existing = presentNames(content, names);
    }
    const entrySha = allowlistEntrySha256(entry);
    return {
      outcome: "ready",
      destRealpath: command.path,
      parent: parentIdentity,
      file: fileIdentity,
      allowlistEntrySha256: entrySha,
      consumer: entry.consumer,
      existingNames: existing,
      requestDigest: computeDigest({
        command,
        names,
        destRealpath: command.path,
        parent: parentIdentity,
        file: fileIdentity,
        entrySha256: entrySha,
      }),
    };
  } catch (error) {
    return toRefusal(error);
  } finally {
    await closeAll(opened);
  }
}

function toRefusal(error: unknown): Refused {
  if (error instanceof SecretRefusal) return refused(error.reason);
  return refused("internal-error");
}

const commitLanes = new Map<string, Promise<void>>();

const ORPHAN_NAME =
  /^\.bb-secret-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/u;
const DEFAULT_ORPHAN_MIN_AGE_MS = 60_000;
const activeTempNames = new Set<string>();

async function sweepOrphans(
  parent: FileHandle,
  config: SecretWriterConfig,
): Promise<void> {
  const minAge = config.orphanMinAgeMs ?? DEFAULT_ORPHAN_MIN_AGE_MS;
  try {
    const names = await fs.readdir(`/proc/self/fd/${parent.fd}`);
    for (const name of names) {
      if (!ORPHAN_NAME.test(name) || activeTempNames.has(name)) continue;
      try {
        const stat = await fs.lstat(fdPath(parent, name));
        if (
          !stat.isFile() ||
          stat.uid !== config.trustedUid ||
          (stat.mode & 0o777) !== 0o600 ||
          config.now() - stat.mtimeMs < minAge
        ) {
          continue;
        }
        await fs.unlink(fdPath(parent, name));
      } catch {
        continue;
      }
    }
  } catch {
    return;
  }
}

export function commitSecretValues(
  command: CommitCommand,
  config: SecretWriterConfig,
): Promise<CommitResult> {
  return runInSerialLane(commitLanes, command.path, () =>
    commitUnserialized(command, config),
  );
}

async function commitUnserialized(
  command: CommitCommand,
  config: SecretWriterConfig,
): Promise<CommitResult> {
  const opened: FileHandle[] = [];
  let tmpName: string | null = null;
  let activeName: string | null = null;
  let parentHandle: FileHandle | null = null;
  const step = async (name: SecretCommitStep): Promise<void> => {
    await config.afterStep?.(name);
  };
  try {
    const { parts, names } = checkDestination(command, config);
    const valueNames = Object.keys(command.values).sort();
    if (valueNames.join("\0") !== [...names].sort().join("\0")) {
      throw new SecretRefusal("invalid-request");
    }
    const entry = matchAllowlist(await loadAllowlist(config), command, names);
    const entrySha = allowlistEntrySha256(entry);
    if (entrySha !== command.allowlistEntrySha256) {
      throw new SecretRefusal("allowlist-changed");
    }
    const expectedDigest = computeDigest({
      command,
      names,
      destRealpath: command.path,
      parent: command.parent,
      file: command.file,
      entrySha256: entrySha,
    });
    if (expectedDigest !== command.requestDigest) {
      throw new SecretRefusal("digest-mismatch");
    }

    const dirParts = parts.slice(0, -1);
    const fileName = parts[parts.length - 1]!;

    const chain = await openDirectoryChain(dirParts);
    opened.push(...chain.all);
    parentHandle = chain.parent;
    if (!sameIdentity(await identityOf(parentHandle), command.parent)) {
      throw new SecretRefusal("identity-changed");
    }
    await assertParentTrusted(parentHandle, config);
    await sweepOrphans(parentHandle, config);
    await step("parent-open");

    const target = await openTarget(parentHandle, fileName);
    let currentContent = "";
    if (target) {
      opened.push(target);
      await assertFileTrusted(target, config);
      if (!sameIdentity(await identityOf(target), command.file)) {
        throw new SecretRefusal("identity-changed");
      }
      try {
        currentContent = await readDotenv(target);
      } catch (error) {
        if (error instanceof SecretRefusal) throw error;
        throw new SecretRefusal("unreconcilable-file");
      }
    } else if (command.file !== null) {
      throw new SecretRefusal("identity-changed");
    }
    let merged;
    try {
      merged = reconcileDotenv(currentContent, command.values);
    } catch {
      throw new SecretRefusal("unreconcilable-file");
    }
    await step("target-read");

    const mergedBytes = Buffer.from(merged.content, "utf8");
    const mergedSha = sha256Hex(mergedBytes);
    await sweepOrphans(parentHandle, config);
    tmpName = `.bb-secret-${randomUUID()}.tmp`;
    activeName = tmpName;
    activeTempNames.add(tmpName);
    const tmp = await fs.open(
      fdPath(parentHandle, tmpName),
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        fsConstants.O_NOFOLLOW,
      0o600,
    );
    let tmpIdentity: Identity;
    try {
      await tmp.writeFile(mergedBytes);
      await tmp.chmod(0o600);
      await tmp.sync();
      tmpIdentity = await identityOf(tmp);
    } finally {
      await tmp.close().catch(() => undefined);
    }
    await step("tmp-written");

    const recheck = await openTarget(parentHandle, fileName);
    try {
      const recheckIdentity = recheck ? await identityOf(recheck) : null;
      if (!sameIdentity(recheckIdentity, command.file)) {
        throw new SecretRefusal(
          command.file === null ? "target-appeared" : "identity-changed",
        );
      }
    } finally {
      await recheck?.close().catch(() => undefined);
    }
    await step("pre-rename-check");
    if (command.file !== null) {
      await fs.rename(
        fdPath(parentHandle, tmpName),
        fdPath(parentHandle, fileName),
      );
    } else {
      try {
        await fs.link(
          fdPath(parentHandle, tmpName),
          fdPath(parentHandle, fileName),
        );
      } catch (error) {
        if (isFsErrorWithCode(error, "EEXIST")) {
          throw new SecretRefusal("target-appeared");
        }
        throw error;
      }
      await fs.unlink(fdPath(parentHandle, tmpName));
    }
    tmpName = null;
    await parentHandle.sync();
    await step("renamed");

    const counts = {
      added: merged.added,
      updated: merged.updated,
      unchanged: merged.unchanged,
    };
    const outcome = await verifyCommit({
      dirParts,
      fileName,
      parent: command.parent,
      expectedFile: tmpIdentity,
      expectedSha: mergedSha,
    });
    await step("verified");
    return { outcome, ...counts };
  } catch (error) {
    if (tmpName !== null && parentHandle !== null) {
      await fs.unlink(fdPath(parentHandle, tmpName)).catch(() => undefined);
    }
    return toRefusal(error);
  } finally {
    if (activeName !== null) activeTempNames.delete(activeName);
    await closeAll(opened);
  }
}

async function verifyCommit(args: {
  dirParts: readonly string[];
  fileName: string;
  parent: Identity;
  expectedFile: Identity;
  expectedSha: string;
}): Promise<"written" | "committed-elsewhere" | "replaced-after-commit"> {
  const opened: FileHandle[] = [];
  try {
    let chain;
    try {
      chain = await openDirectoryChain(args.dirParts);
    } catch (error) {
      if (error instanceof SecretRefusal) return "committed-elsewhere";
      throw error;
    }
    opened.push(...chain.all);
    if (!sameIdentity(await identityOf(chain.parent), args.parent)) {
      return "committed-elsewhere";
    }
    const entry = await openTarget(chain.parent, args.fileName).catch(
      () => null,
    );
    if (!entry) return "replaced-after-commit";
    opened.push(entry);
    if (!sameIdentity(await identityOf(entry), args.expectedFile)) {
      return "replaced-after-commit";
    }
    const bytes = await entry.readFile();
    return sha256Hex(bytes) === args.expectedSha
      ? "written"
      : "replaced-after-commit";
  } finally {
    await closeAll(opened);
  }
}

function productionConfig(): SecretWriterConfig {
  return {
    allowlistPath: DEFAULT_SECRET_ALLOWLIST_PATH,
    allowlistOwnerUid: 0,
    homeDir: fsSync.realpathSync(os.homedir()),
    trustedUid: process.geteuid?.() ?? -1,
    now: () => Date.now(),
  };
}

export function probeHostSecret(command: ProbeCommand): Promise<ProbeResult> {
  return probeSecretDestination(command, productionConfig());
}

export function commitHostSecret(
  command: CommitCommand,
): Promise<CommitResult> {
  return commitSecretValues(command, productionConfig());
}
