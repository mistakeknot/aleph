import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readPoolInput } from "./exec-input.js";

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
}));

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(tmpdir(), "pool-fd-test-"));
  roots.push(root);
  const dir = path.join(root, "input");
  const outside = path.join(root, "outside");
  await fs.mkdir(dir, { mode: 0o700 });
  await fs.mkdir(outside);
  await fs.writeFile(path.join(dir, "prompt"), "allowed", { mode: 0o600 });
  await fs.writeFile(path.join(outside, "prompt"), "forbidden", {
    mode: 0o600,
  });
  return {
    root,
    dir,
    outside,
    filename: path.join(dir, "prompt"),
    env: { HOME: path.join(root, "home") },
  };
}

describe("pool exec stdin descriptors", () => {
  it("creates a missing input directory privately before opening its file", async () => {
    const f = await fixture();
    const directory = path.join(
      f.env.HOME,
      ".local/state/bb-account-pool/exec-input",
    );
    await expect(
      readPoolInput(directory, path.join(directory, "missing"), f.env),
    ).rejects.toThrow("ENOENT");
    const stat = await fs.stat(directory);
    expect(stat.isDirectory()).toBe(true);
    expect(stat.mode & 0o7777).toBe(0o700);
    expect(stat.uid).toBe(process.geteuid?.());
  });

  it.each([0o755, 0o770, 0o1700])(
    "refuses an existing directory with mode %o without changing it",
    async (mode) => {
      const f = await fixture();
      await fs.chmod(f.dir, mode);
      await expect(readPoolInput(f.dir, f.filename, f.env)).rejects.toThrow(
        "owned by the daemon user with mode 0700",
      );
      expect((await fs.stat(f.dir)).mode & 0o7777).toBe(mode);
    },
  );

  it("checks the opened directory's owner before reading its input", async () => {
    const f = await fixture();
    const uid = process.geteuid?.() ?? -1;
    vi.spyOn(process, "geteuid").mockReturnValue(uid + 1);
    await expect(readPoolInput(f.dir, f.filename, f.env)).rejects.toThrow(
      "owned by the daemon user with mode 0700",
    );
  });

  it("does not create forbidden Codex descendants", async () => {
    const f = await fixture();
    const directory = path.join(f.env.HOME, ".codex", "new-input");
    await expect(
      readPoolInput(directory, path.join(directory, "prompt"), f.env),
    ).rejects.toThrow("unsafe stdin directory");
    await expect(fs.stat(directory)).rejects.toThrow("ENOENT");
  });

  it("reads an allowed regular file through no-follow descriptors", async () => {
    const f = await fixture();
    const open = vi.spyOn(fs, "open");
    expect((await readPoolInput(f.dir, f.filename, f.env)).toString()).toBe(
      "allowed",
    );
    expect(open).toHaveBeenCalledTimes(2);
    expect(Number(open.mock.calls[1]?.[1]) & constants.O_NOFOLLOW).toBe(
      constants.O_NOFOLLOW,
    );
  });

  it("rejects symlinks, nonregular files, nested paths, and oversized files", async () => {
    const f = await fixture();
    await fs.symlink(f.filename, path.join(f.dir, "link"));
    await fs.mkdir(path.join(f.dir, "folder"));
    await expect(
      readPoolInput(f.dir, path.join(f.dir, "link"), f.env),
    ).rejects.toThrow();
    await expect(
      readPoolInput(f.dir, path.join(f.dir, "folder"), f.env),
    ).rejects.toThrow("regular file");
    await expect(
      readPoolInput(f.dir, path.join(f.dir, "folder", "prompt"), f.env),
    ).rejects.toThrow("direct children only");
    await fs.truncate(f.filename, (8 << 20) + 1);
    await expect(readPoolInput(f.dir, f.filename, f.env)).rejects.toThrow(
      "exceeds 8 MiB",
    );
  });

  it("does not follow a leaf swapped for a symlink just before open", async () => {
    const f = await fixture();
    const open = fs.open;
    vi.spyOn(fs, "open").mockImplementation(async (filename, flags, mode) => {
      if ((Number(flags) & constants.O_DIRECTORY) === 0) {
        await fs.rename(f.filename, path.join(f.dir, "old"));
        await fs.symlink(path.join(f.outside, "prompt"), f.filename);
      }
      return open(filename, flags, mode);
    });
    await expect(readPoolInput(f.dir, f.filename, f.env)).rejects.toThrow();
  });

  it("anchors the file open even if the directory path is replaced", async () => {
    const f = await fixture();
    const open = fs.open;
    vi.spyOn(fs, "open").mockImplementation(async (filename, flags, mode) => {
      if ((Number(flags) & constants.O_DIRECTORY) === 0) {
        await fs.rename(f.dir, path.join(f.root, "moved"));
        await fs.symlink(f.outside, f.dir);
      }
      return open(filename, flags, mode);
    });
    expect((await readPoolInput(f.dir, f.filename, f.env)).toString()).toBe(
      "allowed",
    );
  });

  it("rejects protected ancestors through aliases and absent CODEX_HOME", async () => {
    const f = await fixture();
    const alias = path.join(f.root, "alias");
    await fs.symlink(f.dir, alias);
    const env = {
      ...f.env,
      CODEX_HOME: path.join(alias, "not-created", "codex"),
    };
    await expect(readPoolInput(f.dir, f.filename, env)).rejects.toThrow(
      "unsafe stdin directory",
    );
  });
});
