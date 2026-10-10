import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  AlephManifestError,
  canonicalJson,
  checkManifestTransition,
  parseManifestBytes,
  type AlephManifest,
  type ParsedManifest,
} from "./aleph-manifest.js";
import { FileLockTimeoutError, withFileLock } from "./file-lock.js";
import { verifyManifestSignature } from "./aleph-manifest-signature.js";

const STATE_FILE = "floor.json";
const LOCK_FILE = "floor.lock";
const LOCK_TIMEOUT_MS = 30_000;
const MAX_FUTURE_SKEW_MS = 5 * 60_000;
const MAX_VALIDITY_MS = 35 * 24 * 60 * 60_000;

export interface PinnedFloor {
  sequence: number;
  digest: string;
  issued_at: string;
}

export interface FloorStateFiles {
  rename: (from: string, to: string) => Promise<void>;
  fsyncFile: (path: string) => Promise<void>;
  fsyncDir: (path: string) => Promise<void>;
}

export interface FloorState {
  floor: PinnedFloor;
  lastManifest: string | undefined;
}

const defaultFiles: FloorStateFiles = {
  rename,
  async fsyncFile(path) {
    const handle = await open(path, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  },
  async fsyncDir(path) {
    const handle = await open(path, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  },
};

function corrupt(detail: string): AlephManifestError {
  return new AlephManifestError(
    "state-corrupt",
    `update state is unusable: ${detail}`,
  );
}

export async function loadFloorState(
  dir: string,
  pinned: PinnedFloor,
): Promise<FloorState> {
  let text: string;
  try {
    text = await readFile(join(dir, STATE_FILE), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { floor: pinned, lastManifest: undefined };
    }
    throw corrupt("state file cannot be read");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw corrupt("state file is not JSON");
  }
  const record = raw as {
    floor?: Partial<PinnedFloor>;
    last_manifest?: unknown;
  } | null;
  const floor = record?.floor;
  if (
    typeof floor?.sequence !== "number" ||
    typeof floor.digest !== "string" ||
    typeof floor.issued_at !== "string" ||
    typeof record?.last_manifest !== "string"
  ) {
    throw corrupt("state file has an unexpected shape");
  }
  let last: ParsedManifest;
  try {
    last = parseManifestBytes(record.last_manifest);
  } catch {
    throw corrupt("cached manifest does not parse");
  }
  if (
    last.digest !== floor.digest ||
    last.manifest.sequence !== floor.sequence ||
    last.manifest.issued_at !== floor.issued_at
  ) {
    throw corrupt("floor does not match the cached manifest");
  }
  if (floor.sequence < pinned.sequence)
    return { floor: pinned, lastManifest: undefined };
  return {
    floor: {
      sequence: floor.sequence,
      digest: floor.digest,
      issued_at: floor.issued_at,
    },
    lastManifest: record.last_manifest,
  };
}

async function withStateLock<T>(
  dir: string,
  timeoutMs: number,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await withFileLock({
      path: join(dir, LOCK_FILE),
      timeoutMs,
      work: run,
    });
  } catch (error) {
    if (error instanceof FileLockTimeoutError) {
      throw new AlephManifestError(
        "state-locked",
        "update state is locked by another process",
      );
    }
    throw error;
  }
}

async function persistState(
  dir: string,
  parsed: ParsedManifest,
  files: FloorStateFiles,
): Promise<void> {
  await mkdir(dir, { recursive: true });
  const target = join(dir, STATE_FILE);
  const temp = join(dir, `${STATE_FILE}.tmp-${randomBytes(6).toString("hex")}`);
  const body = canonicalJson({
    floor: {
      sequence: parsed.manifest.sequence,
      digest: parsed.digest,
      issued_at: parsed.manifest.issued_at,
    },
    last_manifest: parsed.bytes,
  });
  try {
    const handle = await open(temp, "wx", 0o600);
    try {
      await handle.writeFile(body, "utf8");
    } finally {
      await handle.close();
    }
    await files.fsyncFile(temp);
    await files.rename(temp, target);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
  await files.fsyncDir(dir);
}

export async function acceptManifest(args: {
  manifestBytes: string | Uint8Array;
  signature: string;
  allowedSigners: string;
  stateDir: string;
  pinnedFloor: PinnedFloor;
  now: Date;
  persist?: boolean;
  files?: Partial<FloorStateFiles>;
  sshKeygen?: string;
  lockTimeoutMs?: number;
}): Promise<{ manifest: AlephManifest; persisted: boolean }> {
  const parsed = parseManifestBytes(args.manifestBytes);
  const { manifest } = parsed;
  await verifyManifestSignature({
    manifestBytes: parsed.bytes,
    signature: args.signature,
    allowedSigners: args.allowedSigners,
    expectedFingerprint: manifest.signer_fingerprint,
    now: args.now,
    sshKeygen: args.sshKeygen,
  });

  const persist = args.persist !== false;
  const decide = async (): Promise<void> => {
    const state = await loadFloorState(args.stateDir, args.pinnedFloor);
    const { floor } = state;
    const now = args.now.getTime();
    const issued = Date.parse(manifest.issued_at);
    const expires = Date.parse(manifest.expires_at);

    if (now < Date.parse(floor.issued_at)) {
      throw new AlephManifestError(
        "clock-rollback",
        "the clock is behind the last accepted manifest",
      );
    }
    if (manifest.sequence < floor.sequence) {
      throw new AlephManifestError(
        "sequence-below-floor",
        "manifest is older than the floor",
      );
    }
    if (
      manifest.sequence === floor.sequence &&
      parsed.digest !== floor.digest
    ) {
      throw new AlephManifestError(
        "sequence-conflict",
        "two different manifests carry the same sequence",
        true,
      );
    }
    if (issued < Date.parse(floor.issued_at)) {
      throw new AlephManifestError(
        "issued-before-floor",
        "manifest predates the floor",
      );
    }
    if (issued > now + MAX_FUTURE_SKEW_MS) {
      throw new AlephManifestError(
        "issued-in-future",
        "manifest is issued in the future",
      );
    }
    if (expires <= now) {
      throw new AlephManifestError("expired", "manifest has expired");
    }
    if (expires - issued > MAX_VALIDITY_MS) {
      throw new AlephManifestError(
        "validity-too-long",
        "manifest validity exceeds 35 days",
      );
    }
    if (
      state.lastManifest !== undefined &&
      manifest.sequence > floor.sequence
    ) {
      checkManifestTransition(parseManifestBytes(state.lastManifest), parsed);
    }

    if (persist) {
      await persistState(args.stateDir, parsed, {
        ...defaultFiles,
        ...args.files,
      });
    }
  };
  if (persist) {
    await withStateLock(
      args.stateDir,
      args.lockTimeoutMs ?? LOCK_TIMEOUT_MS,
      decide,
    );
  } else {
    await decide();
  }
  return { manifest, persisted: persist };
}
