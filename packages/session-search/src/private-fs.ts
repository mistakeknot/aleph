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
  | "foreign_owner";

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

function currentUid(): number | null {
  return typeof process.getuid === "function" ? process.getuid() : null;
}

function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function assertOwned(path: string, stats: Stats): void {
  const uid = currentUid();
  if (uid !== null && stats.uid !== uid) {
    throw new StoreSecurityError(
      "foreign_owner",
      path,
      "store path is owned by a different user",
    );
  }
}

export function preparePrivateDirectory(path: string): void {
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
  assertOwned(path, stats);
  if (currentUid() !== null && (stats.mode & 0o077) !== 0) {
    chmodSync(path, PRIVATE_DIR_MODE);
  }
}

export function preparePrivateFile(path: string): void {
  const existing = lstatOrNull(path);
  if (existing === null) {
    closeSync(openSync(path, "wx", PRIVATE_FILE_MODE));
    return;
  }
  tightenPrivateFile(path, existing);
}

export function tightenPrivateFileIfPresent(path: string): boolean {
  const existing = lstatOrNull(path);
  if (existing === null) return false;
  tightenPrivateFile(path, existing);
  return true;
}

function tightenPrivateFile(path: string, stats: Stats): void {
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
  assertOwned(path, stats);
  if (currentUid() !== null && (stats.mode & 0o077) !== 0) {
    chmodSync(path, PRIVATE_FILE_MODE);
  }
}

export function modeOf(path: string): number {
  return lstatSync(path).mode & 0o777;
}
