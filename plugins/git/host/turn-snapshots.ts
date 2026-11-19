import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  TURN_SNAPSHOT_DIFF_LABEL,
  TURN_SNAPSHOT_MAX_FILES,
  TURN_SNAPSHOT_MAX_BYTES,
  TURN_SNAPSHOT_MAX_MS,
  TURN_SNAPSHOT_MAX_PATCH_BYTES,
  TURN_SNAPSHOT_KEEP_TURNS,
  type TurnSnapshotDiff,
} from "@bb/server-contract";

const exec = promisify(execFile);
const NAMESPACE = "refs/bb/turn-snapshots/";
// Design choice: bound file/ref inventory output to 8 MiB.
const LIST_MAX_BYTES = 8 * 1024 * 1024;

interface Target {
  path: string;
  repositoryPath: string;
  branch: string;
}
interface CaptureInput extends Target {
  threadId: string;
  token: string;
  phase: "before" | "after";
}
interface Limits {
  maxFiles: number;
  maxBytes: number;
  maxMs: number;
  maxPatchBytes: number;
  keepTurns: number;
}
const DEFAULTS: Limits = {
  maxFiles: TURN_SNAPSHOT_MAX_FILES,
  maxBytes: TURN_SNAPSHOT_MAX_BYTES,
  maxMs: TURN_SNAPSHOT_MAX_MS,
  maxPatchBytes: TURN_SNAPSHOT_MAX_PATCH_BYTES,
  keepTurns: TURN_SNAPSHOT_KEEP_TURNS,
};
export type SnapshotCapture =
  | { status: "captured"; tree: string }
  | { status: "incomplete" | "not-captured"; reason: string };

export function unavailableSnapshotDiff(
  status: "incomplete" | "not-captured",
  reason: string,
): TurnSnapshotDiff {
  return {
    status,
    reason,
    label: TURN_SNAPSHOT_DIFF_LABEL,
    names: [],
    patch: "",
  };
}

function environment(index?: string): NodeJS.ProcessEnv {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
  return {
    ...env,
    GIT_OPTIONAL_LOCKS: "0",
    GIT_LITERAL_PATHSPECS: "1",
    ...(index ? { GIT_INDEX_FILE: index } : {}),
  };
}

class SnapshotFailure extends Error {}
class NotOwned extends Error {}
function message(error: unknown): string {
  if (error instanceof SnapshotFailure || error instanceof NotOwned)
    return error.message;
  return "capture failed or exceeded a time/output byte cap";
}
async function bounded<T>(
  maxMs: number,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (maxMs <= 0) throw new SnapshotFailure("snapshot time cap");
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new SnapshotFailure("snapshot time cap"));
    }, maxMs);
  });
  try {
    return await Promise.race([work(controller.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
function runner(target: Target, signal: AbortSignal, index?: string) {
  const disabledFilters: string[] = [];
  const base = [
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.untrackedCache=false",
    "-c",
    "core.splitIndex=false",
    "-c",
    "gc.auto=0",
    "-c",
    "maintenance.auto=false",
    "-c",
    "submodule.recurse=false",
  ];
  const run = async (args: string[], maxBuffer = LIST_MAX_BYTES) => {
    signal.throwIfAborted();
    const { stdout } = await exec(
      "git",
      ["-C", target.path, ...base, ...disabledFilters, ...args],
      {
        env: environment(index),
        signal,
        killSignal: "SIGKILL",
        encoding: "buffer",
        maxBuffer,
      },
    );
    signal.throwIfAborted();
    return stdout;
  };
  return {
    run,
    async disableFilters() {
      let keys: string;
      try {
        keys = (
          await run([
            "config",
            "--name-only",
            "--get-regexp",
            "^filter\\..*\\.(clean|process|required)$",
          ])
        ).toString();
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === 1))
          throw error;
        keys = "";
      }
      for (const key of keys.trim().split("\n").filter(Boolean)) {
        const driver = key.slice("filter.".length, key.lastIndexOf("."));
        disabledFilters.push(
          "-c",
          `filter.${driver}.clean=`,
          "-c",
          `filter.${driver}.process=`,
          "-c",
          `filter.${driver}.required=false`,
        );
      }
    },
  };
}
async function verifyWorktree(
  target: Target,
  run: ReturnType<typeof runner>["run"],
) {
  if (!(await fs.lstat(join(target.path, ".git"))).isFile())
    throw new NotOwned("not an owned worktree");
  const top = (await run(["rev-parse", "--show-toplevel"])).toString().trim();
  const common = (
    await run(["rev-parse", "--path-format=absolute", "--git-common-dir"])
  )
    .toString()
    .trim();
  const source = (
    await run([
      "-C",
      target.repositoryPath,
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ])
  )
    .toString()
    .trim();
  const gitDir = (await run(["rev-parse", "--absolute-git-dir"]))
    .toString()
    .trim();
  const linkedFile = (await fs.readFile(join(gitDir, "gitdir"), "utf8")).trim();
  if (
    (await fs.realpath(resolve(gitDir, linkedFile))) !==
    (await fs.realpath(join(target.path, ".git")))
  ) {
    throw new NotOwned("not an owned worktree");
  }
  const branch = (await run(["symbolic-ref", "--short", "HEAD"]))
    .toString()
    .trim();
  if (
    (await fs.realpath(top)) !== (await fs.realpath(target.path)) ||
    (await fs.realpath(common)) !== (await fs.realpath(source)) ||
    branch !== target.branch
  ) {
    throw new NotOwned("not an owned worktree");
  }
}
function paths(buffer: Buffer): string[] {
  return new TextDecoder("utf-8", { fatal: true })
    .decode(buffer)
    .split("\0")
    .filter(Boolean);
}
async function pruneRefs(
  run: ReturnType<typeof runner>["run"],
  prefix: string,
  keep: number,
  incomingToken: string,
) {
  const refs = (await run(["for-each-ref", "--format=%(refname)", prefix]))
    .toString()
    .trim()
    .split("\n")
    .filter(Boolean);
  const tokens = [
    ...new Set([
      ...refs.map((ref) => ref.slice(prefix.length).split("/")[0]!),
      incomingToken,
    ]),
  ].sort();
  const old = new Set(tokens.slice(0, Math.max(0, tokens.length - keep)));
  if (old.has(incomingToken))
    throw new SnapshotFailure("snapshot is outside retained turns");
  const remove = refs.filter((ref) =>
    old.has(ref.slice(prefix.length).split("/")[0]!),
  );
  // Reclaim only private refs; leave object reclamation to normal Git maintenance.
  for (const ref of remove) await run(["update-ref", "-d", ref]);
}

export async function captureSnapshot(
  input: CaptureInput,
  tempRoot: string,
  overrides: Partial<Limits> = {},
): Promise<SnapshotCapture> {
  const limits = { ...DEFAULTS, ...overrides };
  try {
    return await bounded(limits.maxMs, async (signal) => {
      signal.throwIfAborted();
      await fs.mkdir(tempRoot, { recursive: true });
      const dir = await fs.mkdtemp(join(tempRoot, "turn-snapshot-"));
      try {
        const git = runner(input, signal, join(dir, "index"));
        await verifyWorktree(input, git.run);
        await git.disableFilters();
        const prefix =
          NAMESPACE +
          createHash("sha256").update(input.threadId).digest("hex") +
          "/";
        if (!/^[0-9a-z-]+$/u.test(input.token))
          throw new SnapshotFailure("invalid capture token");
        await git.run(["read-tree", "HEAD"]);
        const userIndex = runner(input, signal);
        const inventory = [
          ...new Set([
            ...paths(
              await git.run([
                "ls-files",
                "-z",
                "--cached",
                "--others",
                "--exclude-standard",
              ]),
            ),
            ...paths(await userIndex.run(["ls-files", "-z", "--cached"])),
          ]),
        ];
        if (inventory.length > limits.maxFiles)
          throw new SnapshotFailure("snapshot file cap");
        let bytes = 0;
        for (const path of inventory) {
          signal.throwIfAborted();
          if (
            resolve(input.path, path) === resolve(input.path) ||
            path.split("/").includes("..") ||
            path.startsWith("/")
          )
            throw new SnapshotFailure("invalid capture path");
          try {
            const info = await fs.lstat(join(input.path, path));
            if (!info.isFile() && !info.isSymbolicLink())
              throw new SnapshotFailure("unsupported file kind");
            bytes += info.size;
            if (bytes > limits.maxBytes)
              throw new SnapshotFailure("snapshot byte cap");
          } catch (error) {
            if (
              !(
                error instanceof Error &&
                "code" in error &&
                error.code === "ENOENT"
              )
            )
              throw error;
          }
        }
        if (inventory.length) {
          const pathList = join(dir, "paths");
          await fs.writeFile(pathList, inventory.join("\0") + "\0");
          await git.run([
            "add",
            "-A",
            "-f",
            "--pathspec-from-file=" + pathList,
            "--pathspec-file-nul",
          ]);
        }
        const tree = (await git.run(["write-tree"])).toString().trim();
        const entries = paths(
          await git.run(["ls-tree", "-r", "-l", "-z", tree]),
        );
        const sizes = entries.map((entry) => {
          const value = entry
            .slice(0, entry.indexOf("\t"))
            .trim()
            .split(/\s+/u)
            .at(-1)!;
          if (!/^\d+$/u.test(value))
            throw new SnapshotFailure("unsupported file kind");
          return Number(value);
        });
        if (sizes.length > limits.maxFiles)
          throw new SnapshotFailure("snapshot file cap after capture");
        if (sizes.reduce((sum, value) => sum + value, 0) > limits.maxBytes)
          throw new SnapshotFailure("snapshot byte cap after capture");
        await pruneRefs(git.run, prefix, limits.keepTurns, input.token);
        await git.run([
          "update-ref",
          prefix + input.token + "/" + input.phase,
          tree,
        ]);
        return { status: "captured", tree };
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    });
  } catch (error) {
    return {
      status: error instanceof NotOwned ? "not-captured" : "incomplete",
      reason: message(error),
    };
  }
}
export async function diffSnapshots(
  input: Target & { before: string; after: string },
  overrides: Partial<Limits> = {},
): Promise<TurnSnapshotDiff> {
  const limits = { ...DEFAULTS, ...overrides };
  try {
    return await bounded(limits.maxMs, async (signal) => {
      const git = runner(input, signal);
      await verifyWorktree(input, git.run);
      if (
        ![input.before, input.after].every((tree) =>
          /^[0-9a-f]{40,64}$/u.test(tree),
        )
      )
        throw new SnapshotFailure("invalid snapshot tree");
      const options = [
        "--no-ext-diff",
        "--no-textconv",
        "--find-renames",
        input.before,
        input.after,
      ];
      const patch = (
        await git.run(["diff", "--binary", ...options], limits.maxPatchBytes)
      ).toString("utf8");
      if (Buffer.byteLength(patch) > limits.maxPatchBytes)
        throw new SnapshotFailure("patch byte cap");
      const list = paths(
        await git.run(["diff", "--name-status", "-z", ...options]),
      );
      const names: TurnSnapshotDiff["names"] = [];
      for (let i = 0; i < list.length;) {
        const raw = list[i++]!,
          first = list[i++];
        const status = raw[0];
        if (!first || !["A", "M", "D", "R", "C", "T"].includes(status ?? ""))
          throw new SnapshotFailure("unsupported name-status result");
        const previousPath = status === "R" || status === "C" ? first : null;
        const path = previousPath === null ? first : list[i++];
        if (!path) throw new SnapshotFailure("invalid name-status result");
        names.push({
          status: status as TurnSnapshotDiff["names"][number]["status"],
          path,
          previousPath,
        });
      }
      return {
        status: "captured",
        reason: null,
        label: TURN_SNAPSHOT_DIFF_LABEL,
        patch,
        names,
      };
    });
  } catch (error) {
    return unavailableSnapshotDiff(
      error instanceof NotOwned ? "not-captured" : "incomplete",
      message(error),
    );
  }
}
