import { noopNotifier } from "../../src/notifier.js";
import { createProject } from "../../src/data/projects.js";
import { upsertHost } from "../../src/data/hosts.js";
import { createThread } from "../../src/data/threads.js";
import { createMigratedConnection } from "../../src/testing.js";
import type { DbConnection } from "../../src/connection.js";

export function setupRoles() {
  const db = createMigratedConnection();
  const host = upsertHost(db, noopNotifier, { name: "test-host" });
  const { project } = createProject(db, noopNotifier, {
    name: "test-project",
    source: { type: "local_path", hostId: host.id, path: "/tmp/test" },
  });
  return { db, host, project };
}

export function makeThread(
  db: DbConnection,
  projectId: string,
  title?: string,
) {
  return createThread(db, noopNotifier, {
    projectId,
    providerId: "codex",
    status: "idle",
    ...(title === undefined ? {} : { title }),
  });
}
