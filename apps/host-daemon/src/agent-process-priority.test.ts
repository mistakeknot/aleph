import { spawn } from "node:child_process";
import os from "node:os";
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_AGENT_NICE,
  lowerAgentProcessPriority,
  resolveAgentNice,
  type AgentProcessPriorityDeps,
} from "./agent-process-priority.js";

function fakeDeps(initial: Record<number, number>): AgentProcessPriorityDeps & {
  priorities: Map<number, number>;
} {
  const priorities = new Map(
    Object.entries(initial).map(([tid, nice]) => [Number(tid), nice]),
  );
  return {
    priorities,
    getPriority: (tid) => {
      const nice = priorities.get(tid);
      if (nice === undefined) {
        throw new Error(`no such thread ${tid}`);
      }
      return nice;
    },
    listThreadIds: () => [...priorities.keys()].filter((tid) => tid !== 100),
    setPriority: (tid, nice) => {
      priorities.set(tid, nice);
    },
  };
}

describe("resolveAgentNice", () => {
  it("defaults to nice 10 off Windows", () => {
    expect(resolveAgentNice({ env: {}, platform: "linux" })).toBe(
      DEFAULT_AGENT_NICE,
    );
    expect(resolveAgentNice({ env: {}, platform: "darwin" })).toBe(10);
  });

  it("is off on Windows", () => {
    expect(
      resolveAgentNice({ env: { BB_AGENT_NICE: "15" }, platform: "win32" }),
    ).toBeNull();
  });

  it("honors BB_AGENT_NICE, treats 0 as off and clamps to 19", () => {
    const resolve = (value: string) =>
      resolveAgentNice({ env: { BB_AGENT_NICE: value }, platform: "linux" });
    expect(resolve("15")).toBe(15);
    expect(resolve(" 5 ")).toBe(5);
    expect(resolve("0")).toBeNull();
    expect(resolve("40")).toBe(19);
  });

  it("falls back to the default for unusable values", () => {
    const resolve = (value: string) =>
      resolveAgentNice({ env: { BB_AGENT_NICE: value }, platform: "linux" });
    expect(resolve("")).toBe(10);
    expect(resolve("-5")).toBe(10);
    expect(resolve("high")).toBe(10);
  });
});

describe("lowerAgentProcessPriority", () => {
  const logger = () => ({ warn: vi.fn() });

  it("raises the main thread and existing threads, never lowers", () => {
    const deps = fakeDeps({ 100: 0, 101: 0, 102: 15 });
    const log = logger();
    lowerAgentProcessPriority({
      deps,
      env: {},
      logger: log,
      pid: 100,
      platform: "linux",
      processKind: "test",
    });
    expect(deps.priorities).toEqual(
      new Map([
        [100, 10],
        [101, 10],
        [102, 15],
      ]),
    );
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("does nothing when disabled or the pid is missing", () => {
    const deps = fakeDeps({ 100: 0 });
    const setPriority = vi.spyOn(deps, "setPriority");
    const log = logger();
    lowerAgentProcessPriority({
      deps,
      env: { BB_AGENT_NICE: "0" },
      logger: log,
      pid: 100,
      platform: "linux",
      processKind: "test",
    });
    lowerAgentProcessPriority({
      deps,
      env: {},
      logger: log,
      pid: undefined,
      platform: "linux",
      processKind: "test",
    });
    expect(setPriority).not.toHaveBeenCalled();
  });

  it("ignores threads that exit during the sweep", () => {
    const deps = fakeDeps({ 100: 0, 101: 0 });
    deps.listThreadIds = () => [999, 101];
    const log = logger();
    lowerAgentProcessPriority({
      deps,
      env: {},
      logger: log,
      pid: 100,
      platform: "linux",
      processKind: "test",
    });
    expect(deps.priorities.get(101)).toBe(10);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("logs and continues when the process cannot be reniced", () => {
    const deps = fakeDeps({ 100: 0 });
    deps.setPriority = () => {
      throw new Error("EACCES");
    };
    const log = logger();
    expect(() =>
      lowerAgentProcessPriority({
        deps,
        env: {},
        logger: log,
        pid: 100,
        platform: "linux",
        processKind: "terminal",
      }),
    ).not.toThrow();
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ pid: 100, processKind: "terminal", nice: 10 }),
      "Failed to lower agent process priority",
    );
  });

  it("stays quiet when the process already exited", () => {
    const deps = fakeDeps({ 100: 0 });
    deps.getPriority = () => {
      throw Object.assign(new Error("A system error occurred"), {
        code: "ERR_SYSTEM_ERROR",
        info: { code: "ESRCH" },
      });
    };
    const log = logger();
    lowerAgentProcessPriority({
      deps,
      env: {},
      logger: log,
      pid: 100,
      platform: "linux",
      processKind: "provider-worker",
    });
    expect(log.warn).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === "win32")(
    "lowers a real child and its descendants inherit it",
    async () => {
      const child = spawn(
        "/bin/sh",
        ["-c", "sleep 0.3; sleep 5 & echo $!; wait"],
        { stdio: ["ignore", "pipe", "ignore"] },
      );
      try {
        const log = logger();
        lowerAgentProcessPriority({
          env: { BB_AGENT_NICE: "15" },
          logger: log,
          pid: child.pid,
          processKind: "test",
        });
        const expected = Math.max(15, os.getPriority());
        expect(os.getPriority(child.pid)).toBe(expected);
        const grandchildPid = await new Promise<number>((resolve) => {
          child.stdout.once("data", (data: Buffer) =>
            resolve(Number(data.toString().trim())),
          );
        });
        expect(os.getPriority(grandchildPid)).toBe(expected);
        expect(log.warn).not.toHaveBeenCalled();
      } finally {
        child.kill("SIGKILL");
      }
    },
  );
});
