import { constants, openSync, closeSync, writeSync } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import path from "node:path";

function inside(root: string, value: string): boolean {
  const relative = path.relative(root, value);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

export async function validateExecDirectory(
  cwd: string | null,
  args: readonly string[],
): Promise<string> {
  if (!cwd || !path.isAbsolute(cwd))
    throw new Error("Caller cwd must be an absolute existing directory");
  const canonical = await realpath(cwd);
  if (!(await stat(canonical)).isDirectory())
    throw new Error("Caller cwd must be a directory");
  for (const arg of args.filter((arg) => arg.startsWith("--add-dir="))) {
    const value = arg.slice("--add-dir=".length);
    if (!path.isAbsolute(value) || value.split(path.sep).includes(".."))
      throw new Error("--add-dir must be absolute without traversal");
    const resolved = await realpath(value);
    if (
      resolved !== value ||
      !inside(canonical, resolved) ||
      !(await stat(resolved)).isDirectory()
    )
      throw new Error(
        "--add-dir must be a canonical directory within caller cwd",
      );
  }
  return canonical;
}

function directChild(cwd: string, filename: string): void {
  if (
    !path.isAbsolute(filename) ||
    path.dirname(filename) !== cwd ||
    filename.split(path.sep).includes("..")
  )
    throw new Error(
      "Exec files must be absolute direct children of canonical caller cwd",
    );
}

export async function readExecPrompt(
  cwd: string,
  filename: string,
): Promise<Buffer> {
  directChild(cwd, filename);
  const handle = await open(
    filename,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > 8 << 20)
      throw new Error("Prompt must be a regular file limited to 8 MiB");
    const buffer = Buffer.alloc((8 << 20) + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        length,
        buffer.length - length,
        null,
      );
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > 8 << 20) throw new Error("Prompt exceeds 8 MiB");
    return buffer.subarray(0, length);
  } finally {
    await handle.close();
  }
}

export async function createExecOutput(
  cwd: string,
  filename: string,
  token: string,
) {
  directChild(cwd, filename);
  const flags =
    constants.O_WRONLY |
    constants.O_CREAT |
    constants.O_EXCL |
    constants.O_NOFOLLOW;
  const stdout = openSync(filename, flags, 0o600);
  let stderr;
  try {
    stderr = openSync(`${filename}.stderr`, flags, 0o600);
  } catch (error) {
    closeSync(stdout);
    throw error;
  }
  const secret = Buffer.from(token);
  const replacement = Buffer.from("[REDACTED]");
  const pending = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  const descriptors = { stdout, stderr };
  const flush = (stream: "stdout" | "stderr", final: boolean) => {
    let value = pending[stream];
    let offset;
    while ((offset = value.indexOf(secret)) >= 0) {
      writeAll(descriptors[stream], value.subarray(0, offset));
      writeAll(descriptors[stream], replacement);
      value = value.subarray(offset + secret.length);
    }
    let retained = 0;
    if (!final) {
      for (
        let size = Math.min(value.length, secret.length - 1);
        size > 0;
        size--
      ) {
        if (
          value.subarray(value.length - size).equals(secret.subarray(0, size))
        ) {
          retained = size;
          break;
        }
      }
    }
    writeAll(descriptors[stream], value.subarray(0, value.length - retained));
    pending[stream] = Buffer.from(value.subarray(value.length - retained));
  };
  let closed = false;
  return {
    write(stream: "stdout" | "stderr", chunk: Buffer) {
      if (closed) throw new Error("Exec output is closed");
      pending[stream] = Buffer.concat([pending[stream], chunk]);
      flush(stream, false);
    },
    close() {
      if (closed) return;
      closed = true;
      try {
        flush("stdout", true);
        flush("stderr", true);
      } finally {
        try {
          closeSync(stdout);
        } finally {
          closeSync(stderr);
        }
      }
    },
  };
}

function writeAll(fd: number, buffer: Buffer): void {
  let offset = 0;
  while (offset < buffer.length) offset += writeSync(fd, buffer, offset);
}
