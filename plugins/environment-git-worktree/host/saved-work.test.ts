import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  encodeSavedWorkBranch,
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

  function realIndex(): string {
    return join(repo, ".git", "worktrees", "feature", "index");
  }

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
    await writeFile(join(repo, ".git", "refs", "bb"), "not a directory\n");
    const indexBefore = await readFile(realIndex());

    await expect(removeWorktree({ path: worktree })).rejects.toMatchObject({
      code: "dirty_worktree_not_saved",
    });

    expect(existsSync(join(worktree, "untracked.txt"))).toBe(true);
    expect((await readFile(realIndex())).equals(indexBefore)).toBe(true);
  });

  it("does not write the real index", async () => {
    await writeFile(join(worktree, "staged.txt"), "staged\n");
    await git(worktree, "add", "staged.txt");
    await writeFile(join(worktree, "new.txt"), "new\n");
    await writeFile(join(worktree, "tracked.txt"), "committed on feature\n");
    await utimes(join(worktree, "tracked.txt"), 1_000_000_000, 1_000_000_000);
    const indexBefore = await readFile(realIndex());

    expect(await saveUncommittedWork({ path: worktree })).not.toBeNull();

    expect((await readFile(realIndex())).equals(indexBefore)).toBe(true);
  });

  it("keeps a force-added file that matches an ignore rule", async () => {
    await mkdir(join(worktree, "build"), { recursive: true });
    await writeFile(join(worktree, "build", "keep.txt"), "staged\n");
    await git(worktree, "add", "-f", "build/keep.txt");
    await writeFile(join(worktree, "build", "keep.txt"), "edited after add\n");

    const ref = await saveUncommittedWork({ path: worktree });

    expect(await git(repo, "show", `${ref}:build/keep.txt`)).toBe(
      "edited after add\n",
    );
  });

  it("runs no hooks while saving", async () => {
    const hooks = join(root, "hooks");
    const marker = join(root, "hook-ran");
    await mkdir(hooks, { recursive: true });
    for (const name of ["reference-transaction", "post-index-change"]) {
      await writeFile(
        join(hooks, name),
        `#!/bin/sh\necho ${name} >> "${marker}"\n`,
      );
      await chmod(join(hooks, name), 0o755);
    }
    await git(repo, "config", "core.hooksPath", hooks);
    await writeFile(join(worktree, "tracked.txt"), "unstaged edit\n");
    await writeFile(join(worktree, "new.txt"), "new\n");

    expect(await saveUncommittedWork({ path: worktree })).not.toBeNull();

    expect(existsSync(marker)).toBe(false);
  });

  it("gives every save its own ref under an encoded branch name", async () => {
    await git(worktree, "switch", "-c", "team/50%/feature");
    await writeFile(join(worktree, "new.txt"), "first\n");
    const first = await saveUncommittedWork({ path: worktree });
    await writeFile(join(worktree, "new.txt"), "second\n");
    const second = await saveUncommittedWork({ path: worktree });

    const prefix = `${SAVED_WORK_REF_PREFIX}${encodeSavedWorkBranch("team/50%/feature")}/`;
    expect(prefix).toBe(`${SAVED_WORK_REF_PREFIX}team%2F50%25%2Ffeature/`);
    expect(first).not.toBe(second);
    expect(first!.startsWith(prefix)).toBe(true);
    expect(second!.startsWith(prefix)).toBe(true);
    expect((await savedRefs(repo)).sort()).toEqual([first, second].sort());
    expect(await git(repo, "show", `${first}:new.txt`)).toBe("first\n");
    expect(await git(repo, "show", `${second}:new.txt`)).toBe("second\n");
  });

  it("ignores an inherited GIT_DIR, GIT_WORK_TREE and GIT_INDEX_FILE", async () => {
    const other = join(root, "other");
    await mkdir(other, { recursive: true });
    await git(other, "init", "--initial-branch=main");
    const saved = {
      GIT_DIR: process.env.GIT_DIR,
      GIT_WORK_TREE: process.env.GIT_WORK_TREE,
      GIT_INDEX_FILE: process.env.GIT_INDEX_FILE,
    };
    process.env.GIT_DIR = join(other, ".git");
    process.env.GIT_WORK_TREE = other;
    process.env.GIT_INDEX_FILE = join(other, ".git", "index");
    await writeFile(join(worktree, "new.txt"), "new\n");
    let ref: string | null;
    try {
      ref = await saveUncommittedWork({ path: worktree });
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }

    expect(await git(repo, "show", `${ref}:new.txt`)).toBe("new\n");
    expect(existsSync(join(other, ".git", "index"))).toBe(false);
  });

  it("refuses to remove a worktree whose submodule has uncommitted changes", async () => {
    const sub = join(root, "sub");
    await mkdir(sub, { recursive: true });
    await git(sub, "init", "--initial-branch=main");
    await writeFile(join(sub, "lib.txt"), "lib\n");
    await git(sub, "add", ".");
    await git(sub, "commit", "-m", "lib");
    await git(
      worktree,
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "add",
      sub,
      "lib",
    );
    await git(worktree, "commit", "-m", "add submodule");
    await writeFile(join(worktree, "lib", "lib.txt"), "edited in submodule\n");

    await expect(removeWorktree({ path: worktree })).rejects.toMatchObject({
      code: "dirty_worktree_not_saved",
    });

    expect(await readFile(join(worktree, "lib", "lib.txt"), "utf8")).toBe(
      "edited in submodule\n",
    );
    expect(await savedRefs(repo)).toEqual([]);
  });

  it("refuses to remove a worktree holding an untracked nested repository", async () => {
    const nested = join(worktree, "nested");
    await mkdir(nested, { recursive: true });
    await git(nested, "init", "--initial-branch=main");
    await writeFile(join(nested, "work.txt"), "nested work\n");

    await expect(removeWorktree({ path: worktree })).rejects.toMatchObject({
      code: "dirty_worktree_not_saved",
    });

    expect(existsSync(join(nested, "work.txt"))).toBe(true);
  });
});
