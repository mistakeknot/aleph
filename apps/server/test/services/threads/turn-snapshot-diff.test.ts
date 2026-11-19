import { expect, it, vi } from "vitest";
import {
  TURN_SNAPSHOT_DIFF_LABEL,
  type TurnSnapshotDiff,
} from "@bb/server-contract";
import {
  createTurnSnapshotCoordinator,
  ownedSnapshotTarget,
} from "../../../src/services/threads/turn-snapshot-diff.js";

const target = {
  environmentId: "environment",
  hostId: "host",
  path: "/worktree",
  repositoryPath: "/source",
  branch: "owned",
};
const available = { status: "captured" as const, tree: "a".repeat(40) };
function setup(enabled = true) {
  const capture = vi.fn<
    (
      ...args: unknown[]
    ) => Promise<
      | { status: "captured"; tree: string }
      | { status: "incomplete" | "not-captured"; reason: string }
    >
  >(async () => available);
  const diff = vi.fn<() => Promise<TurnSnapshotDiff>>(async () => ({
    status: "captured" as const,
    reason: null,
    label: TURN_SNAPSHOT_DIFF_LABEL,
    names: [],
    patch: "patch",
  }));
  const resolveTarget = vi.fn<() => typeof target | null>(() => target);
  return {
    capture,
    diff,
    resolveTarget,
    coordinator: createTurnSnapshotCoordinator({
      enabled: () => enabled,
      resolveTarget,
      capture,
      diff,
    }),
  };
}
it("does no ownership lookup or Git work when disabled", async () => {
  const { coordinator, capture, diff, resolveTarget } = setup(false);
  await coordinator.prepare("thread", "request");
  coordinator.started("thread", "turn");
  await coordinator.completed("thread", "turn");
  expect(coordinator.read("thread", "turn").status).toBe("not-captured");
  expect(resolveTarget).not.toHaveBeenCalled();
  expect(capture).not.toHaveBeenCalled();
  expect(diff).not.toHaveBeenCalled();
});
it("captures a baseline before dispatch, then binds the root turn and finishes once", async () => {
  const { coordinator, capture, diff } = setup();
  await coordinator.prepare("thread", "request");
  expect(capture).toHaveBeenCalledTimes(1);
  coordinator.started("thread", "turn");
  expect(coordinator.read("thread", "turn").status).toBe("incomplete");
  await coordinator.completed("thread", "turn");
  await coordinator.completed("thread", "turn");
  expect(capture).toHaveBeenCalledTimes(2);
  expect(diff).toHaveBeenCalledTimes(1);
  expect(coordinator.read("thread", "turn")).toMatchObject({
    status: "captured",
    patch: "patch",
  });
});
it("returns incomplete for a failed baseline and never generates a partial diff", async () => {
  const { coordinator, capture, diff } = setup();
  capture.mockResolvedValueOnce({
    status: "incomplete",
    reason: "snapshot byte cap",
  });
  await coordinator.prepare("thread", "request");
  coordinator.started("thread", "turn");
  await coordinator.completed("thread", "turn");
  expect(coordinator.read("thread", "turn")).toMatchObject({
    status: "incomplete",
    reason: "snapshot byte cap",
    names: [],
    patch: "",
  });
  expect(diff).not.toHaveBeenCalled();
});
it("refuses non-owned or changed environments without a complete diff", async () => {
  const { coordinator, resolveTarget, capture, diff } = setup();
  resolveTarget.mockReturnValueOnce(null);
  await coordinator.prepare("unowned", "request");
  coordinator.started("unowned", "turn");
  await coordinator.completed("unowned", "turn");
  expect(coordinator.read("unowned", "turn")).toMatchObject({
    status: "not-captured",
    reason: "not an owned worktree",
  });
  expect(capture).not.toHaveBeenCalled();
  await coordinator.prepare("thread", "request");
  coordinator.started("thread", "turn");
  resolveTarget.mockReturnValueOnce({ ...target, path: "/changed" });
  await coordinator.completed("thread", "turn");
  expect(coordinator.read("thread", "turn").status).toBe("incomplete");
  expect(diff).not.toHaveBeenCalled();
});
it("does not recapture a steered or retried running turn and bounds result retention", async () => {
  const { coordinator, capture } = setup();
  await coordinator.prepare("thread", "request");
  coordinator.started("thread", "turn");
  await coordinator.prepare("thread", "steer");
  expect(capture).toHaveBeenCalledTimes(1);
  await coordinator.completed("thread", "turn");
  for (let i = 0; i < 12; i++) {
    await coordinator.prepare("thread", "request" + i);
    coordinator.started("thread", "turn" + i);
    await coordinator.completed("thread", "turn" + i);
  }
  expect(coordinator.read("thread", "turn").status).toBe("not-captured");
  expect(coordinator.read("thread", "turn11").status).toBe("captured");
});
it("requires provider-created worktree metadata, the original owner, an owned branch and exclusive assignment", () => {
  const environment = {
    id: "environment",
    hostId: "host",
    path: "/worktree",
    status: "ready",
    ownerThreadId: "thread",
    providerOwnsPath: true,
    environmentProviderId: "git-worktree",
    isWorktree: true,
    resource: { ownedBranch: { name: "owned", repositoryPath: "/source" } },
  };
  expect(ownedSnapshotTarget("thread", environment, ["thread"])).toEqual(
    target,
  );
  for (const change of [
    { ownerThreadId: null },
    { providerOwnsPath: false },
    { isWorktree: false },
    { environmentProviderId: "project-checkout" },
    { resource: { adopted: true } },
  ]) {
    expect(
      ownedSnapshotTarget("thread", { ...environment, ...change }, ["thread"]),
    ).toBeNull();
  }
  expect(
    ownedSnapshotTarget("thread", environment, ["thread", "other"]),
  ).toBeNull();
});

it("shares an in-flight baseline and abandons a failed command before the next turn", async () => {
  const { coordinator, capture } = setup();
  let release: (() => void) | undefined;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  capture.mockImplementationOnce(async () => {
    await wait;
    return available;
  });
  const first = coordinator.prepare("thread", "request");
  const second = coordinator.prepare("thread", "racing-request");
  expect(capture).toHaveBeenCalledTimes(1);
  release?.();
  await Promise.all([first, second]);
  coordinator.abandon("thread", "request");
  await coordinator.prepare("thread", "next");
  expect(capture).toHaveBeenCalledTimes(2);
});

it("discards a result if ownership changes while the end snapshot is running", async () => {
  const { coordinator, capture, resolveTarget } = setup();
  await coordinator.prepare("thread", "request");
  coordinator.started("thread", "turn");
  capture.mockImplementationOnce(async () => {
    resolveTarget.mockReturnValue(null);
    return available;
  });
  await coordinator.completed("thread", "turn");
  expect(coordinator.read("thread", "turn")).toMatchObject({
    status: "incomplete",
    patch: "",
    names: [],
  });
});

it("waits for end capture before preparing the next dispatched turn", async () => {
  const { coordinator, capture } = setup();
  await coordinator.prepare("thread", "first");
  coordinator.started("thread", "turn");
  let release: (() => void) | undefined;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  capture.mockImplementationOnce(async () => {
    await wait;
    return available;
  });
  const end = coordinator.completed("thread", "turn");
  const next = coordinator.prepare("thread", "second");
  expect(capture).toHaveBeenCalledTimes(2);
  release?.();
  await Promise.all([end, next]);
  expect(capture).toHaveBeenCalledTimes(3);
  coordinator.started("thread", "next");
  expect(coordinator.read("thread", "next").status).toBe("incomplete");
});
