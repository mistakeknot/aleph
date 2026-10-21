import { describe, expect, it, vi } from "vitest";
import * as domain from "@bb/domain";
import {
  setupCommandOutputTestEnvironment,
  collectLogLines,
  runCommand,
  stubServerApi,
} from "../helpers/command-output-harness.js";
import type { CommandRegistrar } from "../helpers/command-output-harness.js";
import * as fixtures from "../helpers/command-output-fixtures.js";
import { registerThreadCommands } from "../../commands/thread/index.js";

describe("bb thread update command output", () => {
  setupCommandOutputTestEnvironment();

  const register: CommandRegistrar = (program) =>
    registerThreadCommands(program, () => "http://server");

  it.each(["S1", "none"])(
    "sends section preconditions for %s",
    async (section) => {
      const patch = vi.fn(async () =>
        fixtures.makeThread({
          id: "T",
          projectId: "P",
          providerId: "codex",
          sectionId: "S2",
        }),
      );
      stubServerApi({ "v1.threads.:id.$patch": patch });
      await runCommand(
        [
          "thread",
          "update",
          "T",
          "--section",
          "S2",
          "--if-section",
          section,
          "--if-unpinned",
        ],
        register,
      );
      expect(patch).toHaveBeenCalledWith({
        param: { id: "T" },
        json: {
          sectionId: "S2",
          ifSectionId: section === "none" ? null : section,
          ifUnpinned: true,
        },
      });
    },
  );

  it("sends clear-section and the remaining preconditions", async () => {
    const patch = vi.fn(async () =>
      fixtures.makeThread({ id: "T", projectId: "P", providerId: "codex" }),
    );
    stubServerApi({ "v1.threads.:id.$patch": patch });
    await runCommand(
      [
        "thread",
        "update",
        "T",
        "--clear-section",
        "--if-unarchived",
        "--if-top-level",
      ],
      register,
    );
    expect(patch).toHaveBeenCalledWith({
      param: { id: "T" },
      json: { sectionId: null, ifUnarchived: true, ifTopLevel: true },
    });
  });

  it.each([
    ["--if-unpinned"],
    ["--if-section", "S1", "--section", "S2", "--title", "x"],
    ["--if-top-level", "--section", "S2", "--parent-thread", "T2"],
    ["--if-unarchived", "--section", "S2", "--clear-parent-thread"],
    ["--if-unpinned", "--section", "S2", "--model", "M"],
    ["--if-unpinned", "--section", "S2", "--reasoning-level", "high"],
    ["--if-unpinned", "--section", "S2", "--visibility", "hidden"],
  ])(
    "rejects invalid conditional flags %j before requesting",
    async (...flags) => {
      const patch = vi.fn();
      stubServerApi({ "v1.threads.:id.$patch": patch });
      await expect(
        runCommand(["thread", "update", "T", ...flags], register),
      ).rejects.toThrow("process.exit:1");
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining("Section preconditions require"),
      );
      expect(patch).not.toHaveBeenCalled();
    },
  );

  it("prints current section state on conflict and exits nonzero", async () => {
    const patch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            code: "conflict",
            message: "Section changed",
            details: {
              current: {
                sectionId: "S2",
                pinnedAt: null,
                archivedAt: null,
                parentThreadId: null,
              },
            },
          }),
          { status: 409, headers: { "Content-Type": "application/json" } },
        ),
    );
    stubServerApi({ "v1.threads.:id.$patch": patch });
    await expect(
      runCommand(
        ["thread", "update", "T", "--section", "S3", "--if-section", "S1"],
        register,
      ),
    ).rejects.toThrow("process.exit:1");
    expect(collectLogLines(vi.mocked(console.error))).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^Current state: .*"sectionId":"S2"/),
      ]),
    );
  });

  it("bb thread update sets the parent thread id", async () => {
    const thread: domain.Thread = fixtures.makeThread({
      id: "thread-update-1",
      projectId: "proj-1",
      providerId: "codex",
      status: "idle",
      parentThreadId: "thread-manager-1",
      createdAt: 1,
      updatedAt: 1,
    });
    const get = vi.fn(async () => thread);
    const patch = vi.fn(async () => thread);
    stubServerApi({
      "v1.threads.:id.$get": get,
      "v1.threads.:id.$patch": patch,
    });

    await runCommand(
      [
        "thread",
        "update",
        "thread-update-1",
        "--parent-thread",
        "thread-manager-1",
      ],
      register,
    );

    expect(patch).toHaveBeenCalledWith({
      param: { id: "thread-update-1" },
      json: { parentThreadId: "thread-manager-1" },
    });
    expect(collectLogLines(vi.mocked(console.log))).toContain(
      "Parent: thread-manager-1",
    );
  });

  it("bb thread update changes visibility", async () => {
    const thread = fixtures.makeThread({
      id: "thread-update-visibility",
      projectId: "proj-1",
      providerId: "codex",
      visibility: "hidden",
    });
    const patch = vi.fn(async () => thread);
    stubServerApi({ "v1.threads.:id.$patch": patch });

    await runCommand(
      [
        "thread",
        "update",
        "thread-update-visibility",
        "--visibility",
        "hidden",
      ],
      register,
    );

    expect(patch).toHaveBeenCalledWith({
      param: { id: "thread-update-visibility" },
      json: { visibility: "hidden" },
    });
    expect(collectLogLines(vi.mocked(console.log))).toContain(
      "Visibility: hidden",
    );
  });

  it("bb thread update rejects invalid parent-thread values", async () => {
    const patch = vi.fn(async () =>
      fixtures.makeThread({
        id: "thread-update-invalid-parent",
        projectId: "proj-1",
        providerId: "codex",
      }),
    );
    stubServerApi({ "v1.threads.:id.$patch": patch });

    await expect(
      runCommand(
        [
          "thread",
          "update",
          "thread-update-invalid-parent",
          "--parent-thread",
          "thread/invalid",
        ],
        register,
      ),
    ).rejects.toThrow("process.exit:1");

    expect(console.error).toHaveBeenCalledWith(
      'Error: Invalid ID from --parent-thread: "thread/invalid". IDs must contain only letters, digits, hyphens, and underscores.',
    );
    expect(patch).not.toHaveBeenCalled();
  });

  it("bb thread update clears the parent thread id", async () => {
    vi.stubEnv("BB_THREAD_ID", "thread-update-2");
    const thread: domain.Thread = fixtures.makeThread({
      id: "thread-update-2",
      projectId: "proj-1",
      providerId: "codex",
      status: "idle",
      createdAt: 1,
      updatedAt: 1,
    });
    const get = vi.fn(async () => thread);
    const patch = vi.fn(async () => thread);
    stubServerApi({
      "v1.threads.:id.$get": get,
      "v1.threads.:id.$patch": patch,
    });

    await runCommand(
      ["thread", "update", "--self", "--clear-parent-thread"],
      register,
    );

    expect(patch).toHaveBeenCalledWith({
      param: { id: "thread-update-2" },
      json: { parentThreadId: null },
    });
    expect(collectLogLines(vi.mocked(console.log))).toContain(
      "No parent thread",
    );
  });

  it("bb thread update moves a thread into a section", async () => {
    const thread = fixtures.makeThread({
      id: "thread-section",
      projectId: "proj-1",
      providerId: "codex",
      sectionId: "section-review",
    });
    const patch = vi.fn(async () => thread);
    stubServerApi({ "v1.threads.:id.$patch": patch });

    await runCommand(
      ["thread", "update", "thread-section", "--section", "section-review"],
      register,
    );

    expect(patch).toHaveBeenCalledWith({
      param: { id: "thread-section" },
      json: { sectionId: "section-review" },
    });
  });

  it("bb thread update sets a sticky model and reasoning level override", async () => {
    const thread: domain.Thread = fixtures.makeThread({
      id: "thread-update-3",
      projectId: "proj-1",
      providerId: "claude-code",
      status: "idle",
      createdAt: 1,
      updatedAt: 1,
    });
    const get = vi.fn(async () => thread);
    const patch = vi.fn(async () => thread);
    stubServerApi({
      "v1.threads.:id.$get": get,
      "v1.threads.:id.$patch": patch,
    });

    await runCommand(
      [
        "thread",
        "update",
        "thread-update-3",
        "--model",
        "claude-opus-4-8",
        "--reasoning-level",
        "high",
      ],
      register,
    );

    expect(patch).toHaveBeenCalledWith({
      param: { id: "thread-update-3" },
      json: { model: "claude-opus-4-8", reasoningLevel: "high" },
    });
    const lines = collectLogLines(vi.mocked(console.log));
    expect(lines).toContain("Model: claude-opus-4-8");
    expect(lines).toContain("Reasoning level: high");
  });

  it("bb thread update sets the model override independently", async () => {
    const thread: domain.Thread = fixtures.makeThread({
      id: "thread-update-4",
      projectId: "proj-1",
      providerId: "claude-code",
      status: "idle",
      createdAt: 1,
      updatedAt: 1,
    });
    const get = vi.fn(async () => thread);
    const patch = vi.fn(async () => thread);
    stubServerApi({
      "v1.threads.:id.$get": get,
      "v1.threads.:id.$patch": patch,
    });

    await runCommand(
      ["thread", "update", "thread-update-4", "--model", "claude-opus-4-8"],
      register,
    );

    expect(patch).toHaveBeenCalledWith({
      param: { id: "thread-update-4" },
      json: { model: "claude-opus-4-8" },
    });
  });

  it("bb thread update rejects an invalid reasoning level before calling the API", async () => {
    const patch = vi.fn();
    stubServerApi({ "v1.threads.:id.$patch": patch });

    await expect(
      runCommand(
        ["thread", "update", "thread-update-5", "--reasoning-level", "turbo"],
        register,
      ),
    ).rejects.toThrow("process.exit:1");
    expect(vi.mocked(console.error)).toHaveBeenCalledWith(
      expect.stringContaining("Invalid reasoning level 'turbo'"),
    );
    expect(patch).not.toHaveBeenCalled();
  });
});
