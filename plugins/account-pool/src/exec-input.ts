import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

const INPUT_LIMIT_BYTES = 8 << 20;

function contains(directory: string, candidate: string): boolean {
  const relative = path.relative(directory, candidate);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

async function canonicalPath(value: string): Promise<string> {
  try {
    return await realpath(value);
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      error.code !== "ENOENT"
    )
      throw error;
    const parent = path.dirname(value);
    if (parent === value) throw error;
    return path.join(await canonicalPath(parent), path.basename(value));
  }
}

export async function readPoolInput(
  directory: string,
  filename: string,
  env: NodeJS.ProcessEnv,
): Promise<Buffer> {
  if (process.platform !== "linux")
    throw new Error("stdin files require a Linux host with /proc/self/fd");
  if (!path.isAbsolute(directory) || !path.isAbsolute(filename))
    throw new Error("stdin paths must be absolute");
  const home = path.resolve(env.HOME || homedir());
  const [allowed, protectedHome, codexHome, defaultCodexHome] =
    await Promise.all([
      realpath(directory),
      canonicalPath(home),
      canonicalPath(path.resolve(env.CODEX_HOME || path.join(home, ".codex"))),
      canonicalPath(path.join(home, ".codex")),
    ]);
  if (
    [protectedHome, codexHome, defaultCodexHome].some((protectedPath) =>
      contains(allowed, protectedPath),
    ) ||
    [codexHome, defaultCodexHome].some((protectedPath) =>
      contains(protectedPath, allowed),
    )
  ) {
    throw new Error(
      "unsafe stdin directory: root, home, and Codex credential directories or their ancestors are forbidden",
    );
  }
  if (path.dirname(path.resolve(filename)) !== path.resolve(directory)) {
    throw new Error(
      "stdin file is outside the configured directory (direct children only)",
    );
  }
  const folder = await open(
    allowed,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    const folderFd = `/proc/self/fd/${folder.fd}`;
    if (
      !(await folder.stat()).isDirectory() ||
      (await realpath(folderFd)) !== allowed
    ) {
      throw new Error("stdin directory changed while opening");
    }
    const file = await open(
      `${folderFd}/${path.basename(filename)}`,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const stat = await file.stat();
      if (!stat.isFile()) throw new Error("stdin file must be a regular file");
      if (stat.size > INPUT_LIMIT_BYTES)
        throw new Error("stdin file exceeds 8 MiB");
      const buffer = Buffer.alloc(INPUT_LIMIT_BYTES + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await file.read(
          buffer,
          length,
          buffer.length - length,
          null,
        );
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      if (length > INPUT_LIMIT_BYTES)
        throw new Error("stdin file exceeds 8 MiB");
      return buffer.subarray(0, length);
    } finally {
      await file.close();
    }
  } finally {
    await folder.close();
  }
}
