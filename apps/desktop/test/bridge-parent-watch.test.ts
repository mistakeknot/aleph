import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EXIT_WHEN_PARENT_GONE_ENV,
  installParentExitWatch,
} from "../src/bridge-parent-watch.js";

const posixIt = process.platform === "win32" ? it.skip : it;
const packageRoot = resolve(__dirname, "..");
const tempRoots: string[] = [];
const trackedPids: number[] = [];

function createFakeStdin(): EventEmitter & { resume(): void } {
  return Object.assign(new EventEmitter(), { resume: vi.fn() });
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function canConnect(port: number): Promise<boolean> {
  return new Promise((resolveConnect) => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolveConnect(true);
    });
    socket.once("error", () => resolveConnect(false));
  });
}

async function waitUntil(check: () => Promise<boolean> | boolean): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await check()) {
      return;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  throw new Error("condition was not met in time");
}

afterEach(async () => {
  for (const pid of trackedPids.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  for (const root of tempRoots.splice(0)) {
    await rm(root, { force: true, recursive: true });
  }
});

describe("bridge parent watch", () => {
  it("does nothing unless the desktop opted in", () => {
    const stdin = createFakeStdin();
    const kill = vi.fn();
    expect(installParentExitWatch({ env: {}, kill, stdin })).toBe(false);
    expect(stdin.resume).not.toHaveBeenCalled();
    stdin.emit("end");
    expect(kill).not.toHaveBeenCalled();
  });

  it("terminates the bridge once when the parent pipe closes", () => {
    vi.useFakeTimers();
    try {
      const stdin = createFakeStdin();
      const kill = vi.fn();
      expect(
        installParentExitWatch({
          env: { [EXIT_WHEN_PARENT_GONE_ENV]: "1" },
          forceKillDelayMs: 500,
          kill,
          stdin,
        }),
      ).toBe(true);
      expect(stdin.resume).toHaveBeenCalled();
      stdin.emit("end");
      stdin.emit("close");
      expect(kill).toHaveBeenCalledTimes(1);
      expect(kill).toHaveBeenCalledWith("SIGTERM");
      vi.advanceTimersByTime(500);
      expect(kill).toHaveBeenLastCalledWith("SIGKILL");
    } finally {
      vi.useRealTimers();
    }
  });

  posixIt(
    "exits the bridge and frees its port when the desktop process is killed",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "bb-desktop-parent-watch-"));
      tempRoots.push(root);
      const watchPath = join(root, "watch.mjs");
      const processPath = join(root, "process.mjs");
      await build({
        bundle: true,
        entryPoints: [join(packageRoot, "src", "bridge-parent-watch.ts")],
        format: "esm",
        logLevel: "silent",
        outfile: watchPath,
        platform: "node",
      });
      await build({
        bundle: true,
        entryPoints: [join(packageRoot, "src", "bb-process.ts")],
        format: "esm",
        logLevel: "silent",
        outfile: processPath,
        platform: "node",
      });
      const bridgePath = join(root, "bridge.mjs");
      await writeFile(
        bridgePath,
        `import { createServer } from "node:net";
import { installParentExitWatch } from ${JSON.stringify(watchPath)};
installParentExitWatch({
  env: process.env,
  kill: (signal) => process.kill(process.pid, signal),
  stdin: process.stdin,
});
const server = createServer();
server.listen(0, "127.0.0.1", () => {
  process.stdout.write("bridge " + process.pid + " " + server.address().port + "\\n");
});
`,
      );
      const desktopPath = join(root, "desktop.mjs");
      await writeFile(
        desktopPath,
        `import { startBbAppProcess } from ${JSON.stringify(processPath)};
const entry = startBbAppProcess({
  bridgePath: ${JSON.stringify(bridgePath)},
  cwd: ${JSON.stringify(root)},
  env: process.env,
  logLineLimit: 20,
  runtime: { executablePath: process.execPath, kind: "direct", mode: "node" },
});
entry.childProcess.stdout.on("data", (chunk) => process.stdout.write(chunk));
setInterval(() => undefined, 1000);
`,
      );

      const desktop = spawn(process.execPath, [desktopPath], {
        stdio: ["ignore", "pipe", "inherit"],
      });
      if (desktop.pid !== undefined) {
        trackedPids.push(desktop.pid);
      }
      let output = "";
      desktop.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString("utf8");
      });
      await waitUntil(() => /bridge \d+ \d+/u.test(output));
      const match = /bridge (\d+) (\d+)/u.exec(output);
      const bridgePid = Number(match?.[1]);
      const port = Number(match?.[2]);
      trackedPids.push(bridgePid);
      expect(await canConnect(port)).toBe(true);

      desktop.kill("SIGKILL");

      await waitUntil(() => !isAlive(bridgePid));
      expect(await canConnect(port)).toBe(false);
      await new Promise<void>((resolveListen, rejectListen) => {
        const probe = createServer();
        probe.once("error", rejectListen);
        probe.listen(port, "127.0.0.1", () => {
          probe.close(() => resolveListen());
        });
      });
    },
  );
});
