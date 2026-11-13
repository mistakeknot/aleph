import type { WakeAttribution } from "@bb/domain";
import {
  createProject,
  createThread,
  listQueuedThreadMessages,
  noopNotifier,
  retireQueuedThreadMessages,
  upsertHost,
} from "@bb/db";
import { createMigratedConnection } from "@bb/db/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setPluginThreadEventEmitter } from "../../../src/services/plugins/plugin-thread-events.js";
import type { PluginThreadEventEmitter } from "../../../src/services/plugins/plugin-service.js";
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
  options: WakeAttribution & { withdrawWhenPending?: boolean } = {},
) {
  return postCoalescedSystemNotice<string[]>(deps, {
    ...options,
    coalesceKey: COALESCE_KEY,
    execution: {
      model: "gpt-5",
      permissionMode: "full",
      reasoningLevel: "medium",
      serviceTier: "default",
      source: "client/turn/requested",
    },
    merge: (previous) => {
      if (options.withdrawWhenPending && previous !== null) return null;
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

afterEach(() => {
  setPluginThreadEventEmitter(undefined);
});

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
    expect(JSON.parse(rows[0]!.coalesceState!)).toEqual({
      state: ["child-a", "child-b"],
      wake: {
        sources: [
          { wakeCause: "unknown", wakeRef: null },
          { wakeCause: "unknown", wakeRef: null },
        ],
        truncated: false,
        wakeCause: "unknown",
        wakeRef: null,
      },
    });
    expect(second?.sendAt).toBeGreaterThanOrEqual(first?.sendAt ?? 0);
    expect(notifyThread).toHaveBeenCalledWith(successor.id, ["queue-changed"]);
  });

  it("still batches on the requested thread when it is not retired", () => {
    const { db, deps, parent } = setup();
    post(deps, parent.id, "child-a");
    post(deps, parent.id, "child-b");
    const rows = listQueuedThreadMessages(db, parent.id);
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.coalesceState!)).toEqual({
      state: ["child-a", "child-b"],
      wake: {
        sources: [
          { wakeCause: "unknown", wakeRef: null },
          { wakeCause: "unknown", wakeRef: null },
        ],
        truncated: false,
        wakeCause: "unknown",
        wakeRef: null,
      },
    });
  });

  it("withdraws the successor's batch through the retired parent", () => {
    const { db, deps, notifyThread, parent, project, successor } = setup();
    const cancelled: string[] = [];
    setPluginThreadEventEmitter({
      emitMessageCancelled: (entry: { id: string }) => cancelled.push(entry.id),
      emitMessageQueued: () => {},
    } as unknown as PluginThreadEventEmitter);
    const retired = retireQueuedThreadMessages(db, {
      projectId: project.id,
      sourceThreadId: parent.id,
      targetThreadId: successor.id,
      operationKey: "retire-parent",
      retireEnabled: true,
      resolveWaitingOn: () => ({ kind: "thread-busy" }),
    });
    expect(retired.kind).toBe("retired");

    const batch = post(deps, parent.id, "child-a");
    expect(batch?.threadId).toBe(successor.id);
    expect(listQueuedThreadMessages(db, successor.id)).toHaveLength(1);
    notifyThread.mockClear();

    const withdrawn = post(deps, parent.id, "child-a", {
      withdrawWhenPending: true,
    });

    expect(withdrawn).toBeNull();
    expect(listQueuedThreadMessages(db, successor.id)).toEqual([]);
    expect(listQueuedThreadMessages(db, parent.id)).toEqual([]);
    expect(cancelled).toEqual([batch?.id]);
    expect(notifyThread).toHaveBeenCalledWith(successor.id, ["queue-changed"]);
    expect(notifyThread).toHaveBeenCalledWith(parent.id, ["queue-changed"]);
  });
});

it("replays bounded mixed coalesced provenance without losing notice state", () => {
  const { db, deps, parent } = setup();
  try {
    post(deps, parent.id, "first", { wakeCause: "message", wakeRef: "note-1" });
    const mixed = post(deps, parent.id, "second", {
      wakeCause: "timer",
      wakeRef: "deadline-2",
    });
    expect(mixed).toMatchObject({ wakeCause: "unknown", wakeRef: "note-1" });
    expect(JSON.parse(mixed!.coalesceState!)).toMatchObject({
      state: ["first", "second"],
      wake: {
        sources: [
          { wakeCause: "message", wakeRef: "note-1" },
          { wakeCause: "timer", wakeRef: "deadline-2" },
        ],
        truncated: false,
      },
    });
    for (let i = 0; i < 35; i++)
      post(deps, parent.id, String(i), {
        wakeCause: "message",
        wakeRef: String(i),
      });
    const row = listQueuedThreadMessages(db, parent.id)[0]!;
    const stored = JSON.parse(row.coalesceState!);
    expect(stored.wake.sources).toHaveLength(32);
    expect(stored.wake.truncated).toBe(true);
    expect(stored.state).toHaveLength(37);
    expect(row).toMatchObject({ wakeCause: "unknown", wakeRef: "note-1" });
    expect(stored.wake.wakeRef).toBe("note-1");
  } finally {
    db.$client.close();
  }
});
