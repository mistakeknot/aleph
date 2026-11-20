import { describe, expect, it, vi } from "vitest";
import {
  setupCommandOutputTestEnvironment,
  runCommand,
  stubServerApi,
} from "../helpers/command-output-harness.js";
import { makeThread } from "../helpers/command-output-fixtures.js";
import { registerThreadCommands } from "../../commands/thread/index.js";

describe("thread spawn prompt cache TTL", () => {
  setupCommandOutputTestEnvironment();
  const register = (program: Parameters<typeof registerThreadCommands>[0]) =>
    registerThreadCommands(program, () => "http://server");
  it("passes a thread-scoped TTL", async () => {
    const post = vi.fn(async () =>
      makeThread({
        id: "thread-cache",
        projectId: "proj-1",
        providerId: "claude-code",
      }),
    );
    stubServerApi({ "v1.threads.$post": post });
    await runCommand(
      [
        "thread",
        "spawn",
        "--project",
        "proj-1",
        "--prompt",
        "hello",
        "--prompt-cache-ttl",
        "1h",
      ],
      register,
    );
    expect(post).toHaveBeenCalledWith({
      json: expect.objectContaining({ execution: { promptCacheTtl: "1h" } }),
    });
  });
  it("rejects unknown TTLs before posting", async () => {
    const post = vi.fn();
    stubServerApi({ "v1.threads.$post": post });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await expect(
      runCommand(
        [
          "thread",
          "spawn",
          "--project",
          "proj-1",
          "--prompt",
          "hello",
          "--prompt-cache-ttl",
          "2h",
        ],
        register,
      ),
    ).rejects.toThrow();
    expect(post).not.toHaveBeenCalled();
  });
});
