import { afterEach, describe, expect, it } from "vitest";
import {
  completeFullStackSupervision,
  superviseFullStackProcesses,
} from "../src/launcher.js";
import type {
  BbAppStartContext,
  ManagedFullStackProcesses,
  ManagedProcessName,
  ManagedProcessRun,
  NamedProcessExitResult,
  ProcessExitResult,
} from "../src/launcher.js";
import { DEFAULT_RESTART_POLICY } from "../src/restart-policy.js";

class FakeManagedProcessRun implements ManagedProcessRun {
  readonly exit: Promise<NamedProcessExitResult>;
  readonly terminationSignals: NodeJS.Signals[] = [];
  private resolveExit: (result: NamedProcessExitResult) => void = () =>
    undefined;

  constructor(
    readonly processName: ManagedProcessName,
    private readonly events: string[],
  ) {
    this.exit = new Promise<NamedProcessExitResult>((resolvePromise) => {
      this.resolveExit = resolvePromise;
    });
  }

  exitWith(result: ProcessExitResult): void {
    this.resolveExit({ processName: this.processName, result });
  }

  async terminate(signal: NodeJS.Signals): Promise<void> {
    this.terminationSignals.push(signal);
    this.events.push(`${this.processName}-terminated`);
    this.exitWith({ code: null, signal });
  }
}

const CONTEXT: BbAppStartContext = {
  appDistDir: "/tmp/bb-app-test/app/dist",
  appVersion: "0.0.0-test",
  configFile: "/tmp/bb-app-test/config.json",
  daemonBundleDir: "/tmp/bb-app-test/host-daemon/dist",
  daemonEntry: "/tmp/bb-app-test/host-daemon/dist/daemon-bundle.mjs",
  daemonLockDir: "/tmp/bb-app-test/daemon.lock.lock",
  daemonLockFile: "/tmp/bb-app-test/daemon.lock",
  daemonPort: 1,
  dataDir: "/tmp/bb-app-test",
  dbPath: "/tmp/bb-app-test/bb.db",
  envFile: "/tmp/bb-app-test/env.json",
  logDir: "/tmp/bb-app-test/logs",
  packageRoot: "/tmp/bb-app-test/package",
  serverEntry: "/tmp/bb-app-test/server/dist/index.js",
  serverPort: 2,
  serverUrl: "http://127.0.0.1:2",
};

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  }
}

describe("full-stack supervisor restarts", () => {
  const savedExitCode = process.exitCode;
  afterEach(() => {
    process.exitCode = savedExitCode;
  });

  it("notices a dead server while the daemon is still being restarted", async () => {
    const events: string[] = [];
    const serverRun = new FakeManagedProcessRun("server", events);
    const daemonRun = new FakeManagedProcessRun("daemon", events);
    const processes: ManagedFullStackProcesses = { daemonRun, serverRun };
    let shutdown = false;
    let daemonStarts = 0;
    let serverStarts = 0;
    const replacementServers: FakeManagedProcessRun[] = [];

    const supervision = superviseFullStackProcesses({
      context: CONTEXT,
      delayMilliseconds: async () => undefined,
      isHealthyServerAnswering: async () => false,
      isShutdownRequested: () => shutdown,
      onServerMoved: async () => {
        throw new Error("Unexpected server move");
      },
      processes,
      readServerMovedFile: async () => null,
      restartPolicy: DEFAULT_RESTART_POLICY,
      startDaemon: async () => {
        daemonStarts += 1;
        const run = new FakeManagedProcessRun("daemon", events);
        processes.daemonRun = run;
        if (daemonStarts === 1) {
          // The daemon cannot become healthy without a server: its start only
          // fails once the daemon process is stopped.
          events.push("daemon-start-waiting");
          await run.exit;
          processes.daemonRun = null;
          throw new Error("Host daemon failed to become healthy");
        }
        events.push("daemon-started");
        return run;
      },
      startServer: async () => {
        serverStarts += 1;
        events.push("server-started");
        const run = new FakeManagedProcessRun("server", events);
        replacementServers.push(run);
        processes.serverRun = run;
        return run;
      },
    });

    daemonRun.exitWith({ code: 1, signal: null });
    await waitFor(() => events.includes("daemon-start-waiting"));
    serverRun.exitWith({ code: 1, signal: null });

    await waitFor(() => events.includes("daemon-started"));
    shutdown = true;
    replacementServers[0]?.exitWith({ code: 0, signal: null });
    expect(await supervision).toBe("shutdown");

    expect(serverStarts).toBe(1);
    expect(events).toEqual([
      "daemon-start-waiting",
      "daemon-terminated",
      "server-started",
      "daemon-started",
    ]);
  });

  it("restarts the server first when it is already gone before the daemon restart begins", async () => {
    const events: string[] = [];
    const serverRun = new FakeManagedProcessRun("server", events);
    const processes: ManagedFullStackProcesses = {
      daemonRun: null,
      serverRun,
    };
    serverRun.exitWith({ code: 1, signal: null });
    let shutdown = false;
    const replacement = new FakeManagedProcessRun("server", events);

    const supervision = superviseFullStackProcesses({
      context: CONTEXT,
      delayMilliseconds: async () => undefined,
      isHealthyServerAnswering: async () => false,
      isShutdownRequested: () => shutdown,
      onServerMoved: async () => {
        throw new Error("Unexpected server move");
      },
      processes,
      readServerMovedFile: async () => null,
      restartPolicy: DEFAULT_RESTART_POLICY,
      startDaemon: async () => {
        events.push("daemon-started");
        const run = new FakeManagedProcessRun("daemon", events);
        processes.daemonRun = run;
        shutdown = true;
        setTimeout(() => replacement.exitWith({ code: 0, signal: null }), 0);
        return run;
      },
      startServer: async () => {
        events.push("server-started");
        processes.serverRun = replacement;
        return replacement;
      },
    });

    expect(await supervision).toBe("shutdown");
    expect(events).toEqual(["server-started", "daemon-started"]);
  });

  it("backs off between server restarts and gives up after the configured number of failures", async () => {
    const events: string[] = [];
    const serverRun = new FakeManagedProcessRun("server", events);
    const daemonRun = new FakeManagedProcessRun("daemon", events);
    const processes: ManagedFullStackProcesses = { daemonRun, serverRun };
    const delays: number[] = [];
    let serverStarts = 0;

    const supervision = superviseFullStackProcesses({
      context: CONTEXT,
      delayMilliseconds: async ({ ms }) => {
        delays.push(ms);
      },
      isHealthyServerAnswering: async () => false,
      isShutdownRequested: () => false,
      onServerMoved: async () => {
        throw new Error("Unexpected server move");
      },
      processes,
      readServerMovedFile: async () => null,
      restartPolicy: { ...DEFAULT_RESTART_POLICY, maxConsecutiveFailures: 4 },
      startDaemon: async () => daemonRun,
      startServer: async () => {
        serverStarts += 1;
        throw new Error("Server failed to become healthy: ENOSPC");
      },
    });

    serverRun.exitWith({ code: 1, signal: null });

    expect(await supervision).toBe("failed");
    // Failure 1 is the exit, failures 2 to 4 are failed starts.
    expect(delays).toEqual([1_000, 2_000, 4_000]);
    expect(serverStarts).toBe(3);
    expect(daemonRun.terminationSignals).toEqual(["SIGTERM"]);
  });

  it("counts a daemon that keeps dying right after it starts", async () => {
    const events: string[] = [];
    const serverRun = new FakeManagedProcessRun("server", events);
    const firstDaemon = new FakeManagedProcessRun("daemon", events);
    const processes: ManagedFullStackProcesses = {
      daemonRun: firstDaemon,
      serverRun,
    };
    const delays: number[] = [];
    let nowMs = 0;
    let daemonStarts = 0;

    const supervision = superviseFullStackProcesses({
      context: CONTEXT,
      delayMilliseconds: async ({ ms }) => {
        delays.push(ms);
        nowMs += ms;
      },
      isHealthyServerAnswering: async () => false,
      isShutdownRequested: () => false,
      now: () => nowMs,
      onServerMoved: async () => {
        throw new Error("Unexpected server move");
      },
      processes,
      readServerMovedFile: async () => null,
      restartPolicy: { ...DEFAULT_RESTART_POLICY, maxConsecutiveFailures: 4 },
      startDaemon: async () => {
        daemonStarts += 1;
        const run = new FakeManagedProcessRun("daemon", events);
        processes.daemonRun = run;
        queueMicrotask(() => run.exitWith({ code: 1, signal: null }));
        return run;
      },
      startServer: async () => {
        throw new Error("Unexpected server restart");
      },
    });

    firstDaemon.exitWith({ code: 1, signal: null });

    expect(await supervision).toBe("failed");
    expect(delays).toEqual([1_000, 2_000, 4_000]);
    expect(daemonStarts).toBe(3);
    expect(serverRun.terminationSignals).toEqual(["SIGTERM"]);
  });

  it("starts the streak over once a restarted process stays up", async () => {
    const events: string[] = [];
    const serverRun = new FakeManagedProcessRun("server", events);
    const firstDaemon = new FakeManagedProcessRun("daemon", events);
    const processes: ManagedFullStackProcesses = {
      daemonRun: firstDaemon,
      serverRun,
    };
    const delays: number[] = [];
    let nowMs = 0;
    let daemonStarts = 0;
    let shutdown = false;

    const supervision = superviseFullStackProcesses({
      context: CONTEXT,
      delayMilliseconds: async ({ ms }) => {
        delays.push(ms);
      },
      isHealthyServerAnswering: async () => false,
      isShutdownRequested: () => shutdown,
      now: () => nowMs,
      onServerMoved: async () => {
        throw new Error("Unexpected server move");
      },
      processes,
      readServerMovedFile: async () => null,
      restartPolicy: { ...DEFAULT_RESTART_POLICY, maxConsecutiveFailures: 3 },
      startDaemon: async () => {
        daemonStarts += 1;
        const run = new FakeManagedProcessRun("daemon", events);
        processes.daemonRun = run;
        const startNumber = daemonStarts;
        setTimeout(() => {
          // The first replacement lives past the stable window, the second
          // one dies at once. The timer runs after the supervisor has marked
          // the start healthy, like a real process that lived for a while.
          nowMs += startNumber === 1 ? DEFAULT_RESTART_POLICY.stableUptimeMs : 0;
          if (startNumber === 3) {
            shutdown = true;
            serverRun.exitWith({ code: 0, signal: null });
            return;
          }
          run.exitWith({ code: 1, signal: null });
        }, 0);
        return run;
      },
      startServer: async () => {
        throw new Error("Unexpected server restart");
      },
    });

    firstDaemon.exitWith({ code: 1, signal: null });

    expect(await supervision).toBe("shutdown");
    // Exit 1 (1s), the replacement stayed up so exit 2 starts a new streak
    // (1s), exit 3 continues it (2s). Without the reset this would be 1s, 2s, 4s
    // and the supervisor would already have given up.
    expect(delays).toEqual([1_000, 1_000, 2_000]);
  });
});

describe("completeFullStackSupervision", () => {
  const savedExitCode = process.exitCode;
  afterEach(() => {
    process.exitCode = savedExitCode;
  });

  it("exits non-zero when the supervisor gave up", async () => {
    process.exitCode = undefined;
    await completeFullStackSupervision({
      shutdownPromise: null,
      supervisionResult: "failed",
    });
    expect(process.exitCode).toBe(1);
  });

  it("keeps the zero exit code for a requested shutdown", async () => {
    process.exitCode = undefined;
    await completeFullStackSupervision({
      shutdownPromise: null,
      supervisionResult: "shutdown",
    });
    expect(process.exitCode).toBe(0);
  });
});
