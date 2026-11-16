import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
  rename,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import {
  validateExecDirectory,
  readExecPrompt,
  createExecOutput,
  pinExecDirectory,
} from "./exec-files.js";

it("keeps prompt and output access on the pinned directory after replacement", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "exec-pin-"));
  let pinned: Awaited<ReturnType<typeof pinExecDirectory>> | undefined;
  try {
    const cwd = path.join(root, "work");
    const home = path.join(root, "home");
    const held = path.join(root, "held");
    await mkdir(cwd);
    await mkdir(home);
    await writeFile(path.join(cwd, "prompt"), "original prompt");
    await writeFile(path.join(home, "prompt"), "replacement prompt");
    pinned = await pinExecDirectory(cwd, { HOME: home }, cwd);
    await rename(cwd, held);
    await symlink(home, cwd);
    expect(pinned.isCurrent()).toBe(false);
    expect(
      (
        await readExecPrompt(cwd, path.join(cwd, "prompt"), pinned.fd)
      ).toString(),
    ).toBe("original prompt");
    const output = await createExecOutput(
      cwd,
      path.join(cwd, "output"),
      "SyntheticCredential",
      pinned.fd,
    );
    output.write("stdout", Buffer.from("safe output"));
    output.close();
    expect(await readFile(path.join(held, "output"), "utf8")).toBe(
      "safe output",
    );
    await expect(readFile(path.join(home, "output"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  } finally {
    pinned?.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("validates cwd and confines canonical add-dir grants to cwd", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "exec-files-"));
  try {
    await mkdir(path.join(root, "plan"));
    await symlink(tmpdir(), path.join(root, "escape"));
    expect(
      await validateExecDirectory(root, [`--add-dir=${root}/plan`]),
    ).toEqual(root);
    for (const dir of [null, "relative", `${root}/missing`])
      await expect(validateExecDirectory(dir, [])).rejects.toThrow();
    for (const dir of [tmpdir(), `${root}/escape`, `${root}/../other`])
      await expect(
        validateExecDirectory(root, [`--add-dir=${dir}`]),
      ).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("refuses credential directories and confines cwd to the server workspace", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "exec-boundary-"));
  try {
    const env = { HOME: `${root}/home` };
    await mkdir(`${root}/home/.codex`, { recursive: true });
    await mkdir(`${root}/workspace`);
    await mkdir(`${root}/other`);
    for (const cwd of ["/", root, env.HOME, `${env.HOME}/.codex`])
      await expect(validateExecDirectory(cwd, [], env, root)).rejects.toThrow();
    await expect(
      validateExecDirectory(`${root}/other`, [], env, `${root}/workspace`),
    ).rejects.toThrow();
    expect(
      await validateExecDirectory(
        `${root}/workspace`,
        [],
        env,
        `${root}/workspace`,
      ),
    ).toBe(`${root}/workspace`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("forwards bounded prompt files and streams redacted output beyond 900KB", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "exec-files-"));
  try {
    const prompt = Buffer.alloc(160 * 1024, "p");
    await writeFile(`${root}/prompt`, prompt);
    expect(await readExecPrompt(root, `${root}/prompt`)).toEqual(prompt);
    await symlink(`${root}/prompt`, `${root}/link`);
    await expect(readExecPrompt(root, `${root}/link`)).rejects.toThrow();
    await expect(readExecPrompt(root, "/outside")).rejects.toThrow();
    await writeFile(`${root}/large`, Buffer.alloc((8 << 20) + 1));
    await expect(readExecPrompt(root, `${root}/large`)).rejects.toThrow();
    const sink = await createExecOutput(root, `${root}/output`, "secret-token");
    sink.write("stdout", Buffer.alloc(1_000_000, "x"));
    sink.write("stdout", Buffer.from("secret-"));
    sink.write("stdout", Buffer.from("token🙂"));
    for (const byte of Buffer.from("secret-token!"))
      sink.write("stderr", Buffer.from([byte]));
    sink.close();
    expect((await readFile(`${root}/output`, "utf8")).slice(1_000_000)).toBe(
      "[REDACTED]🙂",
    );
    expect(await readFile(`${root}/output.stderr`, "utf8")).toBe("[REDACTED]!");
    await expect(
      createExecOutput(root, `${root}/output`, "secret-token"),
    ).rejects.toThrow();
    await expect(
      createExecOutput(root, "/outside", "secret-token"),
    ).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
