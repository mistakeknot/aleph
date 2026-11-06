import {
  chmodSync,
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  type Stats,
} from "node:fs";

export type StoreSecurityCode =
  | "symlink"
  | "not_directory"
  | "not_regular_file"
  | "foreign_owner"
  | "unsupported_platform";

export class StoreSecurityError extends Error {
  readonly code: StoreSecurityCode;
  readonly path: string;

  constructor(code: StoreSecurityCode, path: string, message: string) {
    super(message);
    this.name = "StoreSecurityError";
    this.code = code;
    this.path = path;
  }
}

export const PRIVATE_DIR_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

export interface PrivacyCapability {
  enforced: boolean;
  platform: NodeJS.Platform;
  mechanism: "posix-owner-and-mode" | "none";
  reason: string | null;
}

export interface PrivacyIdentity {
  platform: NodeJS.Platform;
  getuid: (() => number) | undefined;
}

function processIdentity(): PrivacyIdentity {
  return {
    platform: process.platform,
    getuid: typeof process.getuid === "function" ? process.getuid : undefined,
  };
}

export function privacyCapability(
  identity: PrivacyIdentity = processIdentity(),
): PrivacyCapability {
  if (identity.getuid === undefined) {
    return {
      enforced: false,
      platform: identity.platform,
      mechanism: "none",
      reason:
        "owner-only access cannot be established on this platform: no POSIX user identity is available and owner-only ACLs are not implemented",
    };
  }
  return {
    enforced: true,
    platform: identity.platform,
    mechanism: "posix-owner-and-mode",
    reason: null,
  };
}

function requireUid(identity: PrivacyIdentity, path: string): number {
  const capability = privacyCapability(identity);
  if (!capability.enforced || identity.getuid === undefined) {
    throw new StoreSecurityError(
      "unsupported_platform",
      path,
      `refusing to create or open the store: ${capability.reason ?? "privacy is not enforceable"}`,
    );
  }
  return identity.getuid();
}

function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function assertOwned(
  path: string,
  stats: Stats,
  identity: PrivacyIdentity,
): void {
  const uid = requireUid(identity, path);
  if (stats.uid !== uid) {
    throw new StoreSecurityError(
      "foreign_owner",
      path,
      "store path is owned by a different user",
    );
  }
}

export function preparePrivateDirectory(
  path: string,
  identity: PrivacyIdentity = processIdentity(),
): void {
  requireUid(identity, path);
  if (lstatOrNull(path) === null) {
    mkdirSync(path, { recursive: true, mode: PRIVATE_DIR_MODE });
  }
  const stats = lstatSync(path);
  if (stats.isSymbolicLink()) {
    throw new StoreSecurityError(
      "symlink",
      path,
      "store directory is a symlink",
    );
  }
  if (!stats.isDirectory()) {
    throw new StoreSecurityError(
      "not_directory",
      path,
      "store path is not a directory",
    );
  }
  assertOwned(path, stats, identity);
  if ((stats.mode & 0o077) !== 0) {
    chmodSync(path, PRIVATE_DIR_MODE);
  }
}

export function preparePrivateFile(
  path: string,
  identity: PrivacyIdentity = processIdentity(),
): void {
  requireUid(identity, path);
  const existing = lstatOrNull(path);
  if (existing === null) {
    closeSync(openSync(path, "wx", PRIVATE_FILE_MODE));
    return;
  }
  tightenPrivateFile(path, existing, identity);
}

export function tightenPrivateFileIfPresent(
  path: string,
  identity: PrivacyIdentity = processIdentity(),
): boolean {
  requireUid(identity, path);
  const existing = lstatOrNull(path);
  if (existing === null) return false;
  tightenPrivateFile(path, existing, identity);
  return true;
}

function tightenPrivateFile(
  path: string,
  stats: Stats,
  identity: PrivacyIdentity,
): void {
  if (stats.isSymbolicLink()) {
    throw new StoreSecurityError("symlink", path, "store file is a symlink");
  }
  if (!stats.isFile()) {
    throw new StoreSecurityError(
      "not_regular_file",
      path,
      "store file is not a regular file",
    );
  }
  assertOwned(path, stats, identity);
  if ((stats.mode & 0o077) !== 0) {
    chmodSync(path, PRIVATE_FILE_MODE);
  }
}

export function modeOf(path: string): number {
  return lstatSync(path).mode & 0o777;
}
