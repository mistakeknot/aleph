import type { PromptInput } from "@bb/domain";
import { noopNotifier } from "../../src/notifier.js";
import { upsertHost } from "../../src/data/hosts.js";
import { createProject } from "../../src/data/projects.js";
import { createThread } from "../../src/data/threads.js";
import {
  claimQueuedThreadMessage,
  createQueuedThreadMessage,
  releaseQueuedMessageClaim,
} from "../../src/data/queued-thread-messages.js";
import {
  getTransferOperation,
  retireQueuedThreadMessages,
} from "../../src/data/transfer-operations.js";
import { queuedThreadMessages } from "../../src/schema.js";
import { asc, eq } from "drizzle-orm";
import { createMigratedConnection } from "../helpers/migrated-connection.js";

function textInput(text: string): PromptInput[] {
  return [{ type: "text", text, mentions: [] }];
}

export function setup() {
  const db = createMigratedConnection();
  const host = upsertHost(db, noopNotifier, { name: "test-host" });
  const { project } = createProject(db, noopNotifier, {
    name: "test-project",
    source: { type: "local_path", hostId: host.id, path: "/tmp/test" },
  });
  const make = () =>
    createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
    });
  return { db, host, project, source: make(), target: make(), make };
}

export type Fixture = ReturnType<typeof setup>;

export function enqueue(
  db: Fixture["db"],
  threadId: string,
  text: string,
  overrides: Partial<Parameters<typeof createQueuedThreadMessage>[2]> = {},
) {
  return createQueuedThreadMessage(db, noopNotifier, {
    threadId,
    content: textInput(text),
    model: "gpt-5",
    reasoningLevel: "medium",
    permissionMode: "full",
    serviceTier: "default",
    waitingOn: null,
    sendAt: null,
    payload: { kind: "inline" },
    systemNotice: null,
    ...overrides,
  });
}

export const resolveWaitingOn = () => ({ kind: "thread-busy" }) as const;

export function retire(
  fixture: Fixture,
  overrides: Partial<Parameters<typeof retireQueuedThreadMessages>[1]> = {},
) {
  return retireQueuedThreadMessages(fixture.db, {
    projectId: fixture.project.id,
    sourceThreadId: fixture.source.id,
    targetThreadId: fixture.target.id,
    operationKey: "key-1",
    retireEnabled: true,
    resolveWaitingOn,
    ...overrides,
  });
}

export function claim(fixture: Fixture, id: string) {
  const claimed = claimQueuedThreadMessage(fixture.db, noopNotifier, id);
  if (!claimed) throw new Error(`claim of ${id} failed`);
  return claimed;
}

export function release(fixture: Fixture, id: string, token: string) {
  return releaseQueuedMessageClaim(fixture.db, noopNotifier, {
    id,
    claimToken: token,
  });
}

export function entries(fixture: Fixture, operationId: string) {
  return getTransferOperation(fixture.db, operationId)?.entries ?? [];
}

export function allRows(fixture: Fixture, threadId: string) {
  return fixture.db
    .select()
    .from(queuedThreadMessages)
    .where(eq(queuedThreadMessages.threadId, threadId))
    .orderBy(asc(queuedThreadMessages.sortKey), asc(queuedThreadMessages.id))
    .all();
}
