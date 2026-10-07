import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  AlephManifestError,
  manifestDigest,
  type AlephManifest,
} from "@bb/config/aleph-manifest";
import {
  acceptManifest,
  type PinnedFloor,
} from "@bb/config/aleph-manifest-floor";
import {
  ALEPH_UPDATE_PROBE_INSTANCE,
  alephInstanceUnit,
  buildRecoverInstance,
  buildRollbackInstance,
  buildUpdateInstance,
  isAlephNonce,
} from "@bb/config/aleph-update-instance";
import {
  selectAlephUpdate,
  type AlephManifestEntry,
} from "@bb/config/aleph-update-select";
import { alephReleaseVersion } from "@bb/config/aleph-version";
import type {
  AlephUpdateCapability,
  AlephUpdateRelease,
  AlephUpdateRunState,
  AlephUpdateSelection,
  SystemAlephUpdateRun,
  SystemAlephUpdateStatus,
} from "@bb/server-contract";
import { ApiError } from "../../errors.js";
import type { ServerLogger } from "../../types.js";

const execFileAsync = promisify(execFile);

const CAPABILITY_MARKER = "polkit-start/1";
const GENERATION_PATH = /^gen\/[0-9]+-[0-9a-f]{12}\/$/u;

export interface AlephUpdateSystem {
  listDir(path: string): Promise<string[] | null>;
  readFile(path: string): Promise<string | null>;
  startUnit(unit: string): Promise<"ok" | "denied" | "failed">;
  unitLoadState(unit: string): Promise<string>;
}

export interface AlephUpdatePaths {
  configDir: string;
  floorStateDir: string;
  polkitRulePath: string;
  publishDir: string;
  stateDir: string;
}

export const DEFAULT_ALEPH_UPDATE_PATHS: Omit<
  AlephUpdatePaths,
  "floorStateDir"
> = {
  configDir: "/etc/aleph-update",
  polkitRulePath: "/etc/polkit-1/rules.d/50-aleph-update.rules",
  publishDir: "/srv/aleph-update/public",
  stateDir: "/var/lib/aleph-update",
};

export type AlephUpdateOperation =
  | {
      operation: "update";
      interrupt: boolean;
      manifestDigest: string;
      nonce: string;
      target: string;
    }
  | {
      operation: "rollback";
      from: string;
      interrupt: boolean;
      nonce: string;
      to: string;
    }
  | { operation: "recover"; nonce: string };

export interface AlephUpdateAuditRecord {
  instance: string | null;
  nonce: string;
  operation: AlephUpdateOperation["operation"];
  outcome:
    | "requested"
    | "started"
    | "existing"
    | "command-only"
    | "absent"
    | "denied"
    | "failed";
}

export type AlephManifestAcceptor = (args: {
  allowedSigners: string;
  manifestBytes: string;
  now: Date;
  pinnedFloor: PinnedFloor;
  signature: string;
  stateDir: string;
}) => Promise<{ manifest: AlephManifest }>;

export interface AlephUpdateService {
  getRun(nonce: string): Promise<SystemAlephUpdateRun>;
  getStatus(): Promise<SystemAlephUpdateStatus>;
  start(operation: AlephUpdateOperation): Promise<SystemAlephUpdateRun>;
}

interface CreateAlephUpdateServiceArgs {
  accept?: AlephManifestAcceptor;
  appVersion: string;
  audit?: (record: AlephUpdateAuditRecord) => void;
  countRunningThreads: () => number;
  logger: ServerLogger;
  notify?: (message: string) => Promise<void>;
  now?: () => number;
  paths: AlephUpdatePaths;
  platform?: NodeJS.Platform;
  system?: AlephUpdateSystem;
}

const AUDIT_RETRY_MS = 5_000;
const AUDIT_OUTBOX_LIMIT = 1_000;

interface RootState {
  installed: AlephUpdateRelease | null;
  predecessor: AlephUpdateRelease | null;
  recoveryRequired: boolean;
}

interface RunRecord {
  counter: number;
  dir: string;
  op: string | null;
  outcome: { code: number; label: string | null } | null;
  started: boolean;
}

export function createNodeAlephUpdateSystem(): AlephUpdateSystem {
  return {
    async listDir(path) {
      try {
        return await readdir(path);
      } catch {
        return null;
      }
    },
    async readFile(path) {
      try {
        return await readFile(path, "utf8");
      } catch {
        return null;
      }
    },
    async startUnit(unit) {
      try {
        await execFileAsync(
          "systemctl",
          ["--no-ask-password", "start", "--no-block", unit],
          { timeout: 15_000 },
        );
        return "ok";
      } catch (error) {
        const stderr = String((error as { stderr?: unknown }).stderr ?? "");
        return /access denied|interactive authentication required|not authorized/iu.test(
          stderr,
        )
          ? "denied"
          : "failed";
      }
    },
    async unitLoadState(unit) {
      try {
        const { stdout } = await execFileAsync(
          "systemctl",
          ["show", "--property=LoadState", "--value", unit],
          { timeout: 5_000 },
        );
        return stdout.trim();
      } catch {
        return "not-found";
      }
    },
  };
}

function parseJson(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asRelease(value: unknown): AlephUpdateRelease | null {
  const record = asRecord(value);
  if (
    record === null ||
    typeof record["aleph"] !== "string" ||
    typeof record["version"] !== "string"
  ) {
    return null;
  }
  return { aleph: record["aleph"], version: record["version"] };
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function artifactKey(platform: NodeJS.Platform): string {
  return platform === "darwin" ? "darwin-arm64" : "linux-x64-closure";
}

function outcomeState(code: number): AlephUpdateRunState {
  switch (code) {
    case 0:
      return "succeeded";
    case 10:
      return "aborted";
    case 11:
      return "rolled-back";
    case 12:
      return "recovery-incomplete";
    case 20:
      return "refused";
    default:
      return "unknown";
  }
}

function instanceOf(operation: AlephUpdateOperation): string {
  switch (operation.operation) {
    case "update":
      return buildUpdateInstance({
        digest: operation.manifestDigest,
        interrupt: operation.interrupt,
        nonce: operation.nonce,
        version: operation.target,
      });
    case "rollback":
      return buildRollbackInstance({
        from: operation.from,
        interrupt: operation.interrupt,
        nonce: operation.nonce,
        to: operation.to,
      });
    case "recover":
      return buildRecoverInstance({ nonce: operation.nonce });
  }
}

function rootCommand(instance: string): string {
  return `systemctl start --no-block ${alephInstanceUnit(instance)}`;
}

export function createAlephUpdateService(
  args: CreateAlephUpdateServiceArgs,
): AlephUpdateService {
  const system = args.system ?? createNodeAlephUpdateSystem();
  const now = args.now ?? Date.now;
  const platform = args.platform ?? process.platform;
  const { paths } = args;
  const accept: AlephManifestAcceptor =
    args.accept ??
    (({ stateDir, ...rest }) =>
      acceptManifest({ ...rest, stateDir, persist: true }));

  async function readCapability(): Promise<AlephUpdateCapability> {
    const load = await system.unitLoadState(
      `aleph-update@${ALEPH_UPDATE_PROBE_INSTANCE}.service`,
    );
    if (load !== "loaded") return "absent";
    const declared = await system.readFile(join(paths.configDir, "capability"));
    const rule = await system.readFile(paths.polkitRulePath);
    if (declared === null || rule === null) return "command-only";
    const tokens = declared.split(/\s+/u);
    return tokens.includes(CAPABILITY_MARKER) && tokens.includes(sha256(rule))
      ? "startable"
      : "command-only";
  }

  async function readRootState(): Promise<RootState> {
    const record = asRecord(
      parseJson(await system.readFile(join(paths.stateDir, "state.json"))),
    );
    return {
      installed: asRelease(record?.["installed"]),
      predecessor: asRelease(record?.["predecessor"]),
      recoveryRequired:
        record?.["recovery_required"] !== undefined &&
        record["recovery_required"] !== null,
    };
  }

  async function readRuns(nonce: string | null): Promise<RunRecord[]> {
    const names = await system.listDir(join(paths.stateDir, "runs"));
    if (names === null) return [];
    const records: RunRecord[] = [];
    for (const name of names) {
      const match = /^([0-9]+)-([0-9a-f]{32})$/u.exec(name);
      if (match === null) continue;
      if (nonce !== null && match[2] !== nonce) continue;
      const dir = join(paths.stateDir, "runs", name);
      const started = asRecord(
        parseJson(await system.readFile(join(dir, "started.json"))),
      );
      const outcome = asRecord(
        parseJson(await system.readFile(join(dir, "outcome.json"))),
      );
      records.push({
        counter: Number(match[1]),
        dir,
        op: typeof started?.["op"] === "string" ? started["op"] : null,
        outcome:
          typeof outcome?.["code"] === "number"
            ? {
                code: outcome["code"],
                label:
                  typeof outcome["label"] === "string"
                    ? outcome["label"]
                    : null,
              }
            : null,
        started: started !== null,
      });
    }
    return records.sort((a, b) => b.counter - a.counter);
  }

  async function hasActiveRecoverRun(): Promise<boolean> {
    const runs = await readRuns(null);
    return runs.some(
      (run) => run.op === "recover" && run.started && run.outcome === null,
    );
  }

  async function getRun(nonce: string): Promise<SystemAlephUpdateRun> {
    if (!isAlephNonce(nonce)) {
      throw new ApiError(400, "invalid_request", "nonce is not valid");
    }
    const run = (await readRuns(nonce))[0];
    if (run !== undefined) {
      if (run.outcome !== null) {
        return {
          detail: run.outcome.label,
          nonce,
          state: outcomeState(run.outcome.code),
        };
      }
      if (!run.started) return { detail: null, nonce, state: "queued" };
      return {
        detail: null,
        nonce,
        state: run.op === "recover" ? "recovering" : "running",
      };
    }
    const requests = await system.listDir(join(paths.stateDir, "requests"));
    const refused = requests?.find(
      (name) => name.startsWith(`${nonce}.`) && name.endsWith(".refused"),
    );
    if (refused !== undefined) {
      const reason = await system.readFile(
        join(paths.stateDir, "requests", refused),
      );
      const trimmed = reason?.trim() ?? "";
      return {
        detail: trimmed === "" ? null : trimmed,
        nonce,
        state: "refused",
      };
    }
    return { detail: null, nonce, state: "not-found" };
  }

  async function readManifest(): Promise<
    | { manifest: AlephManifest; bytes: string }
    | { selection: AlephUpdateSelection; detail: string }
  > {
    const pointer = asRecord(
      parseJson(await system.readFile(join(paths.publishDir, "current.json"))),
    );
    const rawPointer = await system.readFile(
      join(paths.publishDir, "current.json"),
    );
    if (rawPointer === null) {
      return {
        selection: "manifest-missing",
        detail: "No update manifest has been published.",
      };
    }
    const generation = pointer?.["path"];
    if (typeof generation !== "string" || !GENERATION_PATH.test(generation)) {
      return {
        selection: "manifest-invalid",
        detail: "The published manifest pointer is not valid.",
      };
    }
    const bytes = await system.readFile(
      join(paths.publishDir, generation, "manifest.json"),
    );
    const signature = await system.readFile(
      join(paths.publishDir, generation, "manifest.json.sig"),
    );
    const allowedSigners = await system.readFile(
      join(paths.configDir, "allowed_signers"),
    );
    const pinned = asRecord(
      parseJson(
        await system.readFile(join(paths.configDir, "pinned-floor.json")),
      ),
    );
    if (
      bytes === null ||
      signature === null ||
      allowedSigners === null ||
      pinned === null
    ) {
      return {
        selection: "manifest-missing",
        detail:
          "The update manifest, its signature or the trust files are missing.",
      };
    }
    if (
      typeof pinned["sequence"] !== "number" ||
      typeof pinned["digest"] !== "string" ||
      typeof pinned["issued_at"] !== "string"
    ) {
      return {
        selection: "manifest-invalid",
        detail: "The pinned floor file is not valid.",
      };
    }
    try {
      const { manifest } = await accept({
        allowedSigners,
        manifestBytes: bytes,
        now: new Date(now()),
        pinnedFloor: {
          digest: pinned["digest"],
          issued_at: pinned["issued_at"],
          sequence: pinned["sequence"],
        },
        signature,
        stateDir: paths.floorStateDir,
      });
      return { manifest, bytes };
    } catch (error) {
      if (error instanceof AlephManifestError) {
        return {
          selection:
            error.code === "expired" ? "manifest-expired" : "manifest-invalid",
          detail: error.message,
        };
      }
      args.logger.warn(
        { err: error },
        "aleph update manifest could not be checked",
      );
      return {
        selection: "manifest-invalid",
        detail: "The update manifest could not be checked.",
      };
    }
  }

  async function getStatus(): Promise<SystemAlephUpdateStatus> {
    const [capability, rootState] = await Promise.all([
      readCapability(),
      readRootState(),
    ]);
    const running = alephReleaseVersion(args.appVersion);
    const installed =
      rootState.installed ??
      (running === null ? null : { aleph: running, version: args.appVersion });
    const base = {
      activeThreadCount: args.countRunningThreads(),
      capability,
      installed,
      predecessor: rootState.predecessor,
    };

    if (rootState.recoveryRequired) {
      const recovering = await hasActiveRecoverRun();
      return {
        ...base,
        detail: recovering
          ? "A recovery run is in progress."
          : "The last update did not finish cleanly and needs recovery.",
        floor: null,
        selection: recovering ? "recovering" : "recovery-required",
        target: null,
      };
    }

    const loaded = await readManifest();
    if ("selection" in loaded) {
      return {
        ...base,
        detail: loaded.detail,
        floor: null,
        selection: loaded.selection,
        target: null,
      };
    }
    const { manifest, bytes } = loaded;
    const entries: AlephManifestEntry[] = manifest.releases.map((release) => ({
      aleph: release.aleph,
      artifactKeys: Object.keys(release.artifacts),
      migrations: release.db.migrations,
      upstreamBase: release.upstream_base,
      version: release.version,
    }));
    const floor = {
      ageSeconds: Math.max(
        0,
        Math.floor((now() - Date.parse(manifest.issued_at)) / 1000),
      ),
      issuedAt: manifest.issued_at,
      sequence: manifest.sequence,
    };
    const result = selectAlephUpdate({
      artifactKey: artifactKey(platform),
      entries,
      installedVersion: installed?.version ?? args.appVersion,
      revocations: manifest.revocations,
    });
    const release = manifest.releases.find(
      (candidate) => candidate.aleph === result.target,
    );
    return {
      ...base,
      detail: null,
      floor,
      selection: result.selection,
      target:
        release === undefined
          ? null
          : {
              aleph: release.aleph,
              manifestDigest: manifestDigest(bytes),
              version: release.version,
            },
    };
  }

  const outbox: AlephUpdateAuditRecord[] = [];
  let outboxTimer: ReturnType<typeof setTimeout> | null = null;

  function flushOutbox(): boolean {
    while (outbox.length > 0) {
      const next = outbox[0] as AlephUpdateAuditRecord;
      try {
        args.audit?.(next);
      } catch {
        return false;
      }
      outbox.shift();
    }
    return true;
  }

  function scheduleOutboxFlush(): void {
    if (outboxTimer !== null || outbox.length === 0) return;
    outboxTimer = setTimeout(() => {
      outboxTimer = null;
      if (!flushOutbox()) scheduleOutboxFlush();
    }, AUDIT_RETRY_MS);
    outboxTimer.unref();
  }

  function auditEntry(
    operation: AlephUpdateOperation,
    instance: string | null,
    outcome: AlephUpdateAuditRecord["outcome"],
  ): AlephUpdateAuditRecord {
    return {
      instance,
      nonce: operation.nonce,
      operation: operation.operation,
      outcome,
    };
  }

  function requireAudit(entry: AlephUpdateAuditRecord): void {
    args.logger.info(entry, "aleph update request");
    try {
      if (!flushOutbox()) throw new Error("audit outbox is not draining");
      args.audit?.(entry);
    } catch (error) {
      args.logger.error({ err: error }, "aleph update audit sink failed");
      throw new ApiError(
        503,
        "aleph_update_audit_unavailable",
        "The update request could not be recorded, so nothing was started. Try again shortly.",
      );
    }
  }

  function deferAudit(entry: AlephUpdateAuditRecord): void {
    args.logger.info(entry, "aleph update request");
    if (outbox.length === 0) {
      try {
        args.audit?.(entry);
        return;
      } catch (error) {
        args.logger.warn(
          { err: error },
          "aleph update audit sink failed; row queued for retry",
        );
      }
    }
    if (outbox.length >= AUDIT_OUTBOX_LIMIT) {
      args.logger.error(
        { nonce: entry.nonce },
        "aleph update audit outbox full; dropping oldest row",
      );
      outbox.shift();
    }
    outbox.push(entry);
    scheduleOutboxFlush();
  }

  async function notice(
    operation: AlephUpdateOperation,
    outcome: string,
  ): Promise<void> {
    try {
      await args.notify?.(
        `Aleph ${operation.operation} request ${operation.nonce}: ${outcome}`,
      );
    } catch (error) {
      args.logger.warn({ err: error }, "aleph update notice failed");
    }
  }

  async function requireAuditWithNotice(
    operation: AlephUpdateOperation,
    entry: AlephUpdateAuditRecord,
  ): Promise<void> {
    try {
      requireAudit(entry);
    } catch (error) {
      await notice(operation, "audit-unavailable");
      throw error;
    }
  }

  async function record(
    operation: AlephUpdateOperation,
    instance: string | null,
    outcome: AlephUpdateAuditRecord["outcome"],
  ): Promise<void> {
    await requireAuditWithNotice(
      operation,
      auditEntry(operation, instance, outcome),
    );
    await notice(operation, outcome);
  }

  async function recordAfterStart(
    operation: AlephUpdateOperation,
    instance: string,
    outcome: AlephUpdateAuditRecord["outcome"],
  ): Promise<void> {
    deferAudit(auditEntry(operation, instance, outcome));
    await notice(operation, outcome);
  }

  async function start(
    operation: AlephUpdateOperation,
  ): Promise<SystemAlephUpdateRun> {
    let instance: string;
    try {
      instance = instanceOf(operation);
    } catch (error) {
      throw new ApiError(
        400,
        "invalid_request",
        error instanceof Error ? error.message : "request is not valid",
      );
    }
    const existing = await getRun(operation.nonce);
    if (existing.state !== "not-found") {
      await record(operation, instance, "existing");
      return existing;
    }
    const capability = await readCapability();
    const command = rootCommand(instance);
    if (capability === "absent") {
      await record(operation, instance, "absent");
      throw new ApiError(
        409,
        "aleph_update_unavailable",
        "The update helper is not installed on this machine.",
        { details: { command } },
      );
    }
    if (capability === "command-only") {
      await record(operation, instance, "command-only");
      throw new ApiError(
        409,
        "aleph_update_command_only",
        `This machine cannot start updates from the app. Run as root: ${command}`,
        { details: { command } },
      );
    }
    await requireAuditWithNotice(
      operation,
      auditEntry(operation, instance, "requested"),
    );
    const result = await system.startUnit(alephInstanceUnit(instance));
    if (result === "denied") {
      await recordAfterStart(operation, instance, "denied");
      throw new ApiError(
        409,
        "aleph_update_start_denied",
        `Update helper declared startable but start was denied: polkit rule missing or mismatched. Run as root: ${command}`,
        { details: { command } },
      );
    }
    if (result === "failed") {
      await recordAfterStart(operation, instance, "failed");
      throw new ApiError(
        502,
        "aleph_update_start_failed",
        "The update helper could not be started.",
      );
    }
    await recordAfterStart(operation, instance, "started");
    return { detail: null, nonce: operation.nonce, state: "queued" };
  }

  return { getRun, getStatus, start };
}
