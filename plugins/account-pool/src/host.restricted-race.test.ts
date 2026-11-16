import { spawn as nodeSpawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAccountPoolHostEntry } from "./host.js";
import { RESTRICTED_CLAUDE_CONTROLS } from "./exec-args.js";

const swap = vi.hoisted(() => ({
  target: "",
  destination: "",
  held: "",
  happened: false,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    stat: async (...args: Parameters<typeof original.stat>) => {
      const result = await original.stat(...args);
      if (args[0] === swap.target && !swap.happened) {
        swap.happened = true;
        await original.rename(swap.target, swap.held);
        await original.symlink(swap.destination, swap.target);
      }
      return result;
    },
  };
});
afterEach(() => {
  swap.target = "";
  swap.happened = false;
});

function fakeChild() {
  const child = Object.assign(new EventEmitter(), {
    pid: process.pid,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn((_signal: NodeJS.Signals) => {
      setImmediate(() => child.emit("close", null, "SIGTERM"));
      return true;
    }),
  });
  return child;
}

describe("restricted cwd and input boundaries", () => {
  it("rejects a swap after validation stat but before identity capture", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pool-gap-"));
    try {
      const cwd = path.join(root, "work");
      const home = path.join(root, "home");
      await mkdir(cwd);
      await mkdir(home);
      await writeFile(path.join(cwd, "prompt"), "original prompt");
      await writeFile(path.join(home, "prompt"), "replacement prompt");
      Object.assign(swap, {
        target: cwd,
        destination: home,
        held: path.join(root, "held"),
        happened: false,
      });
      const spawn = vi.fn(
        (
          _command: string,
          _args: readonly string[],
          options: {
            cwd?: string;
            env: NodeJS.ProcessEnv;
            stdio: ["pipe", "pipe", "pipe"];
          },
        ) => nodeSpawn("/bin/cat", [], options),
      );
      const harness = experimental_createHostEntryHarness(
        createAccountPoolHostEntry({
          env: { HOME: home },
          checkClaudeScrub: async () => true,
          spawn,
        }),
      );
      const result = await harness.experimental_call("run", {
        provider: "claude",
        args: [...RESTRICTED_CLAUDE_CONTROLS, "-p"],
        cwd,
        workspacePath: cwd,
        stdinDir: null,
        stdinPath: null,
        promptPath: path.join(cwd, "prompt"),
        token: "SyntheticCredential",
        baseUrl: "http://127.0.0.1",
      });
      expect(swap.happened).toBe(true);
      expect(result.exitCode).toBe(1);
      expect(spawn).not.toHaveBeenCalled();
      await harness.experimental_dispose();
    } finally {
      swap.target = "";
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a child cwd inode mismatch before writing stdin", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pool-mismatch-"));
    try {
      await writeFile(path.join(root, "prompt"), "safe prompt");
      const child = fakeChild();
      const spawn = vi.fn(() => {
        setImmediate(() => child.emit("spawn"));
        return child;
      });
      const harness = experimental_createHostEntryHarness(
        createAccountPoolHostEntry({
          env: {},
          checkClaudeScrub: async () => true,
          spawn,
        }),
      );
      const result = await harness.experimental_call("run", {
        provider: "claude",
        args: [...RESTRICTED_CLAUDE_CONTROLS, "-p"],
        cwd: root,
        workspacePath: root,
        stdinDir: null,
        stdinPath: null,
        promptPath: path.join(root, "prompt"),
        token: "SyntheticCredential",
        baseUrl: "http://127.0.0.1",
      });
      expect(result.exitCode).toBe(1);
      expect(child.stdin.writableEnded).toBe(false);
      expect(child.kill).toHaveBeenCalled();
      await harness.experimental_dispose();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([null, "/private-input/prompt"])(
    "requires prompt-file instead of stdin source %s",
    async (stdinPath) => {
      const child = fakeChild();
      const spawn = vi.fn(() => {
        setImmediate(() => {
          child.emit("spawn");
          setTimeout(() => child.emit("close", 0, null), 30);
        });
        return child;
      });
      const harness = experimental_createHostEntryHarness(
        createAccountPoolHostEntry({
          env: {},
          checkClaudeScrub: async () => true,
          readInput: async () => Buffer.from("safe prompt"),
          spawn,
        }),
      );
      const result = await harness.experimental_call("run", {
        provider: "claude",
        args: [...RESTRICTED_CLAUDE_CONTROLS, "-p"],
        cwd: process.cwd(),
        workspacePath: process.cwd(),
        stdinDir: null,
        stdinPath,
        token: "SyntheticCredential",
        baseUrl: "http://127.0.0.1",
      });
      expect(result.started).toBe(false);
      expect(spawn).not.toHaveBeenCalled();
      await harness.experimental_dispose();
    },
  );
});
