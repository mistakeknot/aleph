import { describe, expect, it, vi } from "vitest";
import {
  collectLogPayloads,
  getHelpOutput,
  runCommand,
  setupCommandOutputTestEnvironment,
  stubServerApi,
} from "../helpers/command-output-harness.js";
import { registerThreadCommands } from "../../commands/thread/index.js";

setupCommandOutputTestEnvironment();

const register = (program: Parameters<typeof registerThreadCommands>[0]) =>
  registerThreadCommands(program, () => "https://example.test");

describe("thread wake-outcomes", () => {
  it("returns the shared report as JSON with unknown rates intact", async () => {
    const report = {
      outcomes: [],
      truncated: false,
      nextCursor: null,
      summary: {
        completedTurns: 0,
        unknownCauseRate: null,
        unknownEffectRate: null,
      },
    };
    const get = vi.fn(async () => report);
    stubServerApi({ "v1.threads.:id.wake-outcomes.$get": get });
    await runCommand(
      ["thread", "wake-outcomes", "thread-1", "--json"],
      register,
    );
    expect(get).toHaveBeenCalledWith(
      expect.objectContaining({ param: { id: "thread-1" } }),
    );
    expect(
      collectLogPayloads(vi.mocked(console.log)).map((line) =>
        JSON.parse(line),
      ),
    ).toEqual([report]);
  });

  it("forwards --cursor and emits the continuation unchanged in JSON", async () => {
    const cursor = "opaque+/=cursor";
    const report = {
      outcomes: [],
      truncated: true,
      nextCursor: "next-opaque-cursor",
      summary: {
        completedTurns: 0,
        unknownCauseRate: null,
        unknownEffectRate: null,
      },
    };
    const get = vi.fn(async () => report);
    stubServerApi({ "v1.threads.:id.wake-outcomes.$get": get });
    await runCommand(
      ["thread", "wake-outcomes", "thread-1", "--cursor", cursor, "--json"],
      register,
    );
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith(
      expect.objectContaining({ param: { id: "thread-1" }, query: { cursor } }),
    );
    expect(
      collectLogPayloads(vi.mocked(console.log)).map((line) =>
        JSON.parse(line),
      ),
    ).toEqual([report]);
    expect(
      await getHelpOutput(["thread", "wake-outcomes"], register),
    ).toContain("--cursor");
  });

  it("makes the report discoverable in thread help", async () => {
    expect(await getHelpOutput(["thread"], register)).toContain(
      "wake-outcomes",
    );
  });
});
