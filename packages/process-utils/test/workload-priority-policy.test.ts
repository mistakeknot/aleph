import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  deprioritizeAgentWorkload,
  setAgentWorkloadsLowered,
} from "../src/workload-priority.js";

const priority = vi.hoisted(() => ({
  get: vi.fn(() => 0),
  set: vi.fn(),
}));

vi.mock("node:os", () => ({
  getPriority: priority.get,
  setPriority: priority.set,
}));

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("BB_AGENT_NICE", undefined);
  setAgentWorkloadsLowered(true);
});

afterEach(() => {
  vi.unstubAllEnvs();
  setAgentWorkloadsLowered(false);
});

describe("agent workload priority policy", () => {
  it.each([
    [undefined, 0, 10],
    ["5", 0, 5],
    ["19", 10, 19],
    ["99", 0, 19],
    ["-5", 0, 10],
  ])(
    "lowers priority with BB_AGENT_NICE=%s",
    (configured, current, expected) => {
      vi.stubEnv("BB_AGENT_NICE", configured);
      priority.get.mockReturnValue(current);
      deprioritizeAgentWorkload(123);
      expect(priority.set).toHaveBeenCalledExactlyOnceWith(123, expected);
    },
  );

  it("does not attempt to raise an already reduced priority", () => {
    priority.get.mockReturnValue(19);
    deprioritizeAgentWorkload(123);
    expect(priority.set).not.toHaveBeenCalled();
  });

  it("does not attempt to lower an opted-out process", () => {
    vi.stubEnv("BB_AGENT_NICE", "0");
    deprioritizeAgentWorkload(123);
    expect(priority.set).not.toHaveBeenCalled();
  });

  it("leaves a process alone while the experiment is disabled", () => {
    setAgentWorkloadsLowered(false);
    deprioritizeAgentWorkload(123);
    expect(priority.set).not.toHaveBeenCalled();
  });
});
