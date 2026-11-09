import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  removeWorktree,
  saveUncommittedWork,
  SAVED_WORK_REF_PREFIX,
} from "./worktree.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@example.invalid",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@example.invalid",
    },
  });
  return stdout;
}

async function savedRefs(repo: string): Promise<string[]> {
  const out = await git(
    repo,
    "for-each-ref",
    "--format=%(refname)",
    SAVED_WORK_REF_PREFIX,
  );
  return out.split("\n").filter((line) => line !== "");
}

describe("removeWorktree saves uncommitted work (mk-rygli)", () => {
  let root: string;
  let repo: string;
  let worktree: string;
  let branchHead: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "bb-saved-work-test-"));
    repo = join(root, "repo");
    worktree = join(root, "worktrees", "feature");
    await mkdir(repo, { recursive: true });
    await git(repo, "init", "--initial-branch=main");
    await writeFile(join(repo, ".gitignore"), "build/\n");
    await writeFile(join(repo, "tracked.txt"), "base\n");
    await writeFile(join(repo, "doomed.txt"), "to be deleted\n");
    await writeFile(join(repo, "staged.txt"), "base\n");
    await git(repo, "add", ".");
    await git(repo, "commit", "-m", "initial");
    await mkdir(join(root, "worktrees"), { recursive: true });
    await git(repo, "worktree", "add", "-b", "feature", worktree);
    await writeFile(join(worktree, "tracked.txt"), "committed on feature\n");
    await git(worktree, "commit", "-am", "feature commit");
    branchHead = (await git(repo, "rev-parse", "feature")).trim();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("saves staged, unstaged and untracked changes, leaves ignored files out and keeps the branch", async () => {
    await writeFile(join(worktree, "staged.txt"), "staged version\n");
    await git(worktree, "add", "staged.txt");
    await writeFile(
      join(worktree, "staged.txt"),
      "working version after staging\n",
    );
    await writeFile(join(worktree, "tracked.txt"), "unstaged edit\n");
    await rm(join(worktree, "doomed.txt"));
    await mkdir(join(worktree, "notes"), { recursive: true });
    await writeFile(join(worktree, "notes", "untracked.txt"), "untracked\n");
    await mkdir(join(worktree, "build"), { recursive: true });
    await writeFile(join(worktree, "build", "output.bin"), "ignored\n");

    await removeWorktree({ path: worktree });

    expect(existsSync(worktree)).toBe(false);
    expect((await git(repo, "rev-parse", "feature")).trim()).toBe(branchHead);
    const refs = await savedRefs(repo);
    expect(refs).toHaveLength(1);
    const ref = refs[0]!;
    expect(ref.startsWith(`${SAVED_WORK_REF_PREFIX}feature/`)).toBe(true);

    expect(await git(repo, "show", `${ref}:tracked.txt`)).toBe(
      "unstaged edit\n",
    );
    expect(await git(repo, "show", `${ref}:staged.txt`)).toBe(
      "working version after staging\n",
    );
    expect(await git(repo, "show", `${ref}:notes/untracked.txt`)).toBe(
      "untracked\n",
    );
    const files = (await git(repo, "ls-tree", "-r", "--name-only", ref)).split(
      "\n",
    );
    expect(files).not.toContain("doomed.txt");
    expect(files.some((f) => f.startsWith("build/"))).toBe(false);

    expect((await git(repo, "rev-parse", `${ref}^1`)).trim()).toBe(branchHead);
    expect(await git(repo, "show", `${ref}^2:staged.txt`)).toBe(
      "staged version\n",
    );
  });

  it("adds no staged parent when the index matches the working tree", async () => {
    await writeFile(join(worktree, "staged.txt"), "staged and unchanged\n");
    await git(worktree, "add", "staged.txt");

    const ref = await saveUncommittedWork({ path: worktree });

    expect(ref).not.toBeNull();
    expect(await git(repo, "show", `${ref}:staged.txt`)).toBe(
      "staged and unchanged\n",
    );
    const parents = (await git(repo, "rev-list", "--parents", "-n", "1", ref!))
      .trim()
      .split(" ");
    expect(parents.slice(1)).toEqual([branchHead]);
    // The real index and the branch are untouched.
    expect(
      (await git(worktree, "diff", "--cached", "--name-only")).trim(),
    ).toBe("staged.txt");
    expect((await git(repo, "rev-parse", "feature")).trim()).toBe(branchHead);
  });

  it("saves nothing for a clean worktree", async () => {
    await removeWorktree({ path: worktree });

    expect(existsSync(worktree)).toBe(false);
    expect(await savedRefs(repo)).toEqual([]);
  });

  it("leaves the worktree in place when the work cannot be saved", async () => {
    await writeFile(join(worktree, "untracked.txt"), "keep me\n");
    // A file where the ref directory should be makes update-ref fail.
    await writeFile(join(repo, ".git", "refs", "bb"), "not a directory\n");

    await expect(removeWorktree({ path: worktree })).rejects.toMatchObject({
      code: "dirty_worktree_not_saved",
    });

    expect(existsSync(join(worktree, "untracked.txt"))).toBe(true);
  });
});
