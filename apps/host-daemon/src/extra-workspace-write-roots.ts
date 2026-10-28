import fs from "node:fs";
import path from "node:path";
import type { HostDaemonLogger } from "./logger.js";

export const EXTRA_WORKSPACE_WRITE_ROOTS_ENV = "BB_EXTRA_WORKSPACE_WRITE_ROOTS";

interface ExtraWorkspaceWriteRootsFs {
  realpathSync: (target: string) => string;
  statSync: (target: string) => { isDirectory: () => boolean };
}

export interface ResolveExtraWorkspaceWriteRootsArgs {
  env: NodeJS.ProcessEnv;
  dataDir: string;
  homeDir: string;
  logger: Pick<HostDaemonLogger, "info" | "warn">;
  fs?: ExtraWorkspaceWriteRootsFs;
}

const defaultFs: ExtraWorkspaceWriteRootsFs = {
  realpathSync: (target) => fs.realpathSync.native(target),
  statSync: (target) => fs.statSync(target),
};

function isSameOrInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

function realpathOrSelf(fsImpl: ExtraWorkspaceWriteRootsFs, target: string) {
  try {
    return fsImpl.realpathSync(target);
  } catch {
    return path.resolve(target);
  }
}

function refusalReason(args: {
  entry: string;
  real: string | null;
  isDirectory: boolean;
  homeDir: string;
  dataDir: string;
}): string | null {
  if (!path.isAbsolute(args.entry)) return "not an absolute path";
  if (args.real === null) return "does not exist";
  if (!args.isDirectory) return "not a directory";
  const real = args.real;
  if (path.parse(real).root === real) return "is a filesystem root";
  if (isSameOrInside(real, args.homeDir)) {
    return "is the home directory or contains it";
  }
  if (
    isSameOrInside(real, args.dataDir) ||
    isSameOrInside(args.dataDir, real)
  ) {
    return "overlaps the bb data directory";
  }
  if (isSameOrInside(args.homeDir, real)) {
    const firstSegment = path.relative(args.homeDir, real).split(path.sep)[0];
    if (firstSegment?.startsWith(".")) {
      return "is inside a dot-directory of the home directory";
    }
  }
  return null;
}

export function resolveExtraWorkspaceWriteRoots(
  args: ResolveExtraWorkspaceWriteRootsArgs,
): string[] {
  const raw = args.env[EXTRA_WORKSPACE_WRITE_ROOTS_ENV];
  if (raw === undefined || raw.trim() === "") {
    return [];
  }
  const fsImpl = args.fs ?? defaultFs;
  const homeDir = realpathOrSelf(fsImpl, args.homeDir);
  const dataDir = realpathOrSelf(fsImpl, args.dataDir);
  const accepted: string[] = [];
  for (const segment of raw.split(path.delimiter)) {
    const entry = segment.trim();
    if (entry === "") continue;
    let real: string | null = null;
    let isDirectory = false;
    if (path.isAbsolute(entry)) {
      try {
        real = fsImpl.realpathSync(entry);
        isDirectory = fsImpl.statSync(real).isDirectory();
      } catch {
        real = null;
      }
    }
    const reason = refusalReason({
      entry,
      real,
      isDirectory,
      homeDir,
      dataDir,
    });
    if (reason !== null || real === null) {
      args.logger.warn(
        { entry, reason, env: EXTRA_WORKSPACE_WRITE_ROOTS_ENV },
        "Ignoring extra workspace-write root",
      );
      continue;
    }
    if (!accepted.includes(real)) {
      accepted.push(real);
    }
  }
  if (accepted.length > 0) {
    args.logger.info(
      { roots: accepted, env: EXTRA_WORKSPACE_WRITE_ROOTS_ENV },
      "Extra workspace-write roots enabled for workspace-write threads",
    );
  }
  return accepted;
}
