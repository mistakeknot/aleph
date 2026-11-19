import { execFileSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import { captureSnapshot, diffSnapshots } from "./turn-snapshots.js";

const roots: string[] = [];
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], {
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "turn-snapshot-"));
  roots.push(root);
  const repo = join(root, "repo"),
    path = join(root, "worktree");
  await mkdir(repo);
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.name", "Fixture");
  git(repo, "config", "user.email", "fixture@example.invalid");
  await writeFile(join(repo, ".gitignore"), "ignored/\n");
  await writeFile(join(repo, "file.txt"), "one\ntwo\nthree\n");
  await writeFile(join(repo, "binary.bin"), Buffer.from([0, 1, 2, 3]));
  await mkdir(join(repo, "ignored"));
  await writeFile(join(repo, "ignored/tracked.txt"), "tracked\n");
  git(repo, "add", "-A");
  git(repo, "add", "-f", "ignored/tracked.txt");
  git(repo, "commit", "-m", "Fixture");
  git(repo, "worktree", "add", "-b", "turn", path);
  await writeFile(join(path, "ignored/cache.txt"), "excluded");
  const input = {
    path,
    repositoryPath: repo,
    branch: "turn",
    threadId: "thread",
    token: "0001",
    phase: "before" as const,
  };
  return { root, repo, path, input };
}
async function state(path: string) {
  const index = git(path, "rev-parse", "--git-path", "index").toString().trim();
  return [
    git(path, "status", "--porcelain=v2", "--untracked-files=all"),
    git(path, "diff", "--cached", "--binary"),
    git(path, "rev-parse", "HEAD"),
    git(path, "rev-parse", git(path, "symbolic-ref", "HEAD").toString().trim()),
    await readFile(index),
  ];
}
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

it.each(["edit", "new", "delete", "rename", "binary", "split"] as const)(
  "captures %s without changing the index or staged split",
  async (kind) => {
    const { root, path, input } = await fixture();
    if (kind === "split") {
      await writeFile(join(path, "file.txt"), "staged\ntwo\nthree\n");
      git(path, "add", "file.txt");
      await writeFile(join(path, "file.txt"), "staged\ntwo\nunstaged\n");
    }
    let expected = await state(path);
    const before = await captureSnapshot(input, root);
    expect(await state(path)).toEqual(expected);
    expect(before.status).toBe("captured");
    if (kind === "new") await writeFile(join(path, "new.txt"), "new\n");
    else if (kind === "delete") await rm(join(path, "file.txt"));
    else if (kind === "rename")
      await rename(join(path, "file.txt"), join(path, "renamed.txt"));
    else if (kind === "binary")
      await writeFile(join(path, "binary.bin"), Buffer.from([0, 8, 9, 10]));
    else if (kind === "split")
      await writeFile(join(path, "file.txt"), "staged\ntwo\nunstaged\nagent\n");
    else {
      await writeFile(join(path, "file.txt"), "one\nagent\nthree\n");
      await writeFile(join(path, "ignored/tracked.txt"), "changed\n");
    }
    expected = await state(path);
    const after = await captureSnapshot({ ...input, phase: "after" }, root);
    expect(await state(path)).toEqual(expected);
    expect(after.status).toBe("captured");
    if (before.status !== "captured" || after.status !== "captured")
      throw new Error("Capture failed");
    const diff = await diffSnapshots({
      ...input,
      before: before.tree,
      after: after.tree,
    });
    expect(await state(path)).toEqual(expected);
    expect(diff.status).toBe("captured");
    expect(diff.patch).not.toContain("cache.txt");
    if (kind === "binary") expect(diff.patch).toContain("GIT binary patch");
    else if (kind === "rename")
      expect(diff.names[0]).toMatchObject({
        status: "R",
        previousPath: "file.txt",
        path: "renamed.txt",
      });
    else if (kind === "split") {
      expect(diff.patch).toContain("+agent");
      expect(diff.patch).not.toContain("+staged");
      expect(diff.patch).not.toContain("+unstaged");
    } else expect(diff.names.length).toBeGreaterThan(0);
  },
);
it("reports file, byte, time and patch caps as incomplete", async () => {
  const { root, input } = await fixture();
  expect(await captureSnapshot(input, root, { maxFiles: 1 })).toMatchObject({
    status: "incomplete",
    reason: expect.stringContaining("file"),
  });
  expect(await captureSnapshot(input, root, { maxBytes: 1 })).toMatchObject({
    status: "incomplete",
    reason: expect.stringContaining("byte"),
  });
  expect(await captureSnapshot(input, root, { maxMs: 0 })).toMatchObject({
    status: "incomplete",
    reason: expect.stringContaining("time"),
  });
  const before = await captureSnapshot(input, root);
  await writeFile(join(input.path, "file.txt"), "changed\n");
  const after = await captureSnapshot({ ...input, phase: "after" }, root);
  if (before.status !== "captured" || after.status !== "captured")
    throw new Error("Capture failed");
  expect(
    await diffSnapshots(
      { ...input, before: before.tree, after: after.tree },
      { maxPatchBytes: 1 },
    ),
  ).toMatchObject({ status: "incomplete", patch: "", names: [] });
});
it("refuses a main checkout and disables clean filters and ref hooks", async () => {
  const { root, repo, path, input } = await fixture();
  expect(await captureSnapshot({ ...input, path: repo }, root)).toMatchObject({
    status: "not-captured",
  });
  const marker = join(root, "hook-ran");
  git(repo, "config", "filter.danger.clean", `touch "${marker}"; cat`);
  await writeFile(join(path, ".gitattributes"), "*.txt filter=danger\n");
  const hook = join(repo, ".git/hooks/reference-transaction");
  await writeFile(hook, `#!/bin/sh\ntouch "${marker}"\n`, { mode: 0o755 });
  expect((await captureSnapshot(input, root)).status).toBe("captured");
  await expect(stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
});
it("retains only the latest turn refs and never touches another namespace", async () => {
  const { root, path, input } = await fixture();
  git(path, "update-ref", "refs/other/keep", "HEAD");
  for (let i = 0; i < 4; i++) {
    const result = await captureSnapshot(
      { ...input, token: String(i).padStart(4, "0") },
      root,
      { keepTurns: 2 },
    );
    expect(result.status).toBe("captured");
  }
  const refs = git(
    path,
    "for-each-ref",
    "--format=%(refname)",
    "refs/bb/turn-snapshots/",
  )
    .toString()
    .trim()
    .split("\n");
  expect(refs).toHaveLength(2);
  expect(git(path, "rev-parse", "refs/other/keep")).toEqual(
    git(path, "rev-parse", "HEAD"),
  );
});

it("times out an active capture and includes staged-only ignored files", async () => {
  const { root, path, input } = await fixture();
  const original = await state(path);
  expect(await captureSnapshot(input, root, { maxMs: 1 })).toMatchObject({
    status: "incomplete",
    reason: expect.stringContaining("time"),
  });
  expect(await state(path)).toEqual(original);
  await writeFile(join(path, "ignored/staged.txt"), "staged ignored\n");
  git(path, "add", "-f", "ignored/staged.txt");
  const expected = await state(path);
  const result = await captureSnapshot(input, root);
  expect(await state(path)).toEqual(expected);
  expect(result.status).toBe("captured");
  if (result.status !== "captured") throw new Error("Capture failed");
  expect(git(path, "ls-tree", "-r", result.tree).toString()).toContain(
    "ignored/staged.txt",
  );
  expect(git(path, "ls-tree", "-r", result.tree).toString()).not.toContain(
    "ignored/cache.txt",
  );
});
