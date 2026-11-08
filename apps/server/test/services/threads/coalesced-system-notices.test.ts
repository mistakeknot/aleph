import {
  createProject,
  createThread,
  listQueuedThreadMessages,
  noopNotifier,
  retireQueuedThreadMessages,
  upsertHost,
} from "@bb/db";
import { createMigratedConnection } from "@bb/db/testing";
import { describe, expect, it, vi } from "vitest";
import { postCoalescedSystemNotice } from "../../../src/services/threads/coalesced-system-notices.js";

const COALESCE_KEY = "test-notices";

function setup() {
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
  const notifyThread = vi.fn();
  return {
    db,
    deps: { db, hub: { notifyThread } } as unknown as Parameters<
      typeof postCoalescedSystemNotice
    >[0],
    notifyThread,
    parent: make(),
    project,
    successor: make(),
  };
}

function post(
  deps: Parameters<typeof postCoalescedSystemNotice>[0],
  threadId: string,
  label: string,
) {
  return postCoalescedSystemNotice<string[]>(deps, {
    coalesceKey: COALESCE_KEY,
    execution: {
      model: "gpt-5",
      permissionMode: "full",
      reasoningLevel: "medium",
      serviceTier: "default",
      source: "client/turn/requested",
    },
    merge: (previous) => {
      const state = [...(previous ?? []), label];
      return {
        input: [{ type: "text", text: state.join(","), mentions: [] }],
        notice: { kind: "child-outcome-batch", subject: null },
        state,
      };
    },
    parseState: (stored) => JSON.parse(stored) as string[],
    threadId,
    windowMs: 60_000,
  });
}

describe("postCoalescedSystemNotice", () => {
  it("extends one batch on the successor for notices addressed to a retired parent", () => {
    const { db, deps, notifyThread, parent, project, successor } = setup();
    const retired = retireQueuedThreadMessages(db, {
      projectId: project.id,
      sourceThreadId: parent.id,
      targetThreadId: successor.id,
      operationKey: "retire-parent",
      retireEnabled: true,
      resolveWaitingOn: () => ({ kind: "thread-busy" }),
    });
    expect(retired.kind).toBe("retired");

    const first = post(deps, parent.id, "child-a");
    const second = post(deps, parent.id, "child-b");

    expect(first?.threadId).toBe(successor.id);
    expect(second?.id).toBe(first?.id);
    expect(listQueuedThreadMessages(db, parent.id)).toEqual([]);
    const rows = listQueuedThreadMessages(db, successor.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.coalesceState).toBe(JSON.stringify(["child-a", "child-b"]));
    expect(second?.sendAt).toBeGreaterThanOrEqual(first?.sendAt ?? 0);
    expect(notifyThread).toHaveBeenCalledWith(successor.id, ["queue-changed"]);
  });

  it("still batches on the requested thread when it is not retired", () => {
    const { db, deps, parent } = setup();
    post(deps, parent.id, "child-a");
    post(deps, parent.id, "child-b");
    const rows = listQueuedThreadMessages(db, parent.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.coalesceState).toBe(JSON.stringify(["child-a", "child-b"]));
  });
});
