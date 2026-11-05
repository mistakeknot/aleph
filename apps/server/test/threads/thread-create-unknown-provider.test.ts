import { threads } from "@bb/db";
import { describe, expect, it } from "vitest";
import { readJson } from "../helpers/json.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
} from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";
import { installFakeGitWorktreeProvider } from "../helpers/environment-provider.js";

function seedWorkspace(harness: TestAppHarness) {
  const { host } = seedHostSession(harness.deps, { id: "host-unknown-prov" });
  const { project } = seedProjectWithSource(harness.deps, {
    hostId: host.id,
    path: "/tmp/unknown-provider-project",
  });
  seedEnvironment(harness.deps, {
    hostId: host.id,
    projectId: project.id,
    path: "/tmp/unknown-provider-workspace",
    status: "ready",
  });
  installFakeGitWorktreeProvider(() => ({
    action: "ready",
    environment: {
      type: "host",
      hostId: host.id,
      path: "/tmp/unknown-provider-workspace",
    },
  }));
  return { host, project };
}

function createThread(
  harness: TestAppHarness,
  args: { hostId: string; projectId: string; providerId: string },
) {
  return harness.app.request("/api/v1/threads", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      origin: "app",
      projectId: args.projectId,
      providerId: args.providerId,
      input: [{ type: "text", text: "Start" }],
      environment: {
        type: "host",
        hostId: args.hostId,
        workspace: {
          type: "managed-worktree",
          baseBranch: { kind: "default" },
        },
      },
    }),
  });
}

describe("thread create with an unregistered provider id", () => {
  it("rejects the request, lists the valid provider ids and creates no thread", async () => {
    await withTestHarness(async (harness) => {
      const { host, project } = seedWorkspace(harness);

      const response = await createThread(harness, {
        hostId: host.id,
        projectId: project.id,
        providerId: "claude",
      });

      expect(response.status).toBe(400);
      const body = (await readJson(response)) as {
        code?: string;
        message?: string;
      };
      expect(body.code).toBe("unknown_provider");
      expect(body.message).toContain('Unknown provider "claude"');
      expect(body.message).toContain("claude-code");
      expect(body.message).toContain("codex");
      expect(harness.db.select().from(threads).all()).toHaveLength(0);
    });
  });

  it("still creates a thread for a registered provider id", async () => {
    await withTestHarness(async (harness) => {
      const { host, project } = seedWorkspace(harness);

      const response = await createThread(harness, {
        hostId: host.id,
        projectId: project.id,
        providerId: "codex",
      });

      expect(response.status).toBe(201);
      expect(harness.db.select().from(threads).all()).toHaveLength(1);
    });
  });
});
