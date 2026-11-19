import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  getThread,
  getEnvironment,
  getLatestThreadSequence,
  listThreadIdsInEnvironment,
} from "@bb/db";
import { GIT_PLUGIN_ID } from "@bb/domain";
import {
  TURN_SNAPSHOT_DIFF_LABEL,
  TURN_SNAPSHOT_KEEP_TURNS,
  TURN_SNAPSHOT_MAX_MS,
  turnSnapshotDiffSchema,
  type TurnSnapshotDiff,
} from "@bb/server-contract";
import {
  gitHostContract,
  turnSnapshotCaptureSchema,
} from "bb-plugin-bb--git/contract";
import type { HostDaemonCommand } from "@bb/host-daemon-contract";
import type { WorkSessionDeps } from "../../types.js";
import { callPluginHostRpc } from "../plugins/plugin-host-rpc.js";

interface Target {
  environmentId: string;
  hostId: string;
  path: string;
  repositoryPath: string;
  branch: string;
}
type Capture = z.infer<typeof turnSnapshotCaptureSchema>;
interface CoordinatorDeps {
  enabled(): boolean;
  resolveTarget(threadId: string): Target | null;
  token?(threadId: string): string;
  capture(
    target: Target,
    input: { threadId: string; token: string; phase: "before" | "after" },
  ): Promise<Capture>;
  diff(
    target: Target,
    before: string,
    after: string,
  ): Promise<TurnSnapshotDiff>;
}
interface Pending {
  requestId: string;
  target: Target | null;
  token: string;
  before: Capture;
}
interface Interval {
  threadId: string;
  pending: Pending | null;
  done: boolean;
  result: TurnSnapshotDiff;
}
const resourceSchema = z
  .object({
    ownedBranch: z.object({
      name: z.string().min(1),
      repositoryPath: z.string().min(1),
    }),
  })
  .strict();
// Design choice: cap the in-memory prototype at 32 intervals across all threads.
const MAX_INTERVAL_RECORDS = 32;

function absent(
  status: "not-captured" | "incomplete",
  reason: string,
): TurnSnapshotDiff {
  return {
    status,
    reason,
    label: TURN_SNAPSHOT_DIFF_LABEL,
    names: [],
    patch: "",
  };
}
export function ownedSnapshotTarget(
  threadId: string,
  environment: {
    id: string;
    hostId: string;
    path: string | null;
    status: string;
    ownerThreadId: string | null;
    providerOwnsPath: boolean;
    environmentProviderId: string | null;
    isWorktree: boolean | null;
    resource: unknown;
  },
  assignedThreadIds: string[],
): Target | null {
  const resource = resourceSchema.safeParse(environment.resource);
  if (
    environment.status !== "ready" ||
    environment.path === null ||
    environment.ownerThreadId !== threadId ||
    !environment.providerOwnsPath ||
    environment.environmentProviderId !== "git-worktree" ||
    environment.isWorktree !== true ||
    assignedThreadIds.length !== 1 ||
    assignedThreadIds[0] !== threadId ||
    !resource.success
  )
    return null;
  return {
    environmentId: environment.id,
    hostId: environment.hostId,
    path: environment.path,
    branch: resource.data.ownedBranch.name,
    repositoryPath: resource.data.ownedBranch.repositoryPath,
  };
}
export function createTurnSnapshotCoordinator(deps: CoordinatorDeps) {
  const pending = new Map<string, Pending>();
  const running = new Map<string, string>();
  const preparing = new Map<string, Promise<void>>();
  const completing = new Map<string, Promise<void>>();
  const generations = new Map<string, number>();
  const records = new Map<string, Interval>();
  let counter = 0;
  const key = (threadId: string, turnId: string) =>
    JSON.stringify([threadId, turnId]);
  const limitRecords = (threadId: string) => {
    const own = [...records.entries()].filter(
      ([, entry]) => entry.threadId === threadId,
    );
    for (const [id] of own.slice(
      0,
      Math.max(0, own.length - TURN_SNAPSHOT_KEEP_TURNS),
    ))
      records.delete(id);
    while (records.size > MAX_INTERVAL_RECORDS) {
      const id = records.keys().next().value;
      if (id === undefined) break;
      records.delete(id);
    }
  };
  return {
    async prepare(threadId: string, requestId: string): Promise<void> {
      if (!deps.enabled()) return;
      const ending = completing.get(threadId);
      if (ending) await ending;
      if (running.has(threadId)) return;
      const inFlight = preparing.get(threadId);
      if (inFlight) {
        await inFlight;
        return;
      }
      if (pending.has(threadId)) return;
      const generation = generations.get(threadId) ?? 0;
      const work = (async () => {
        const target = deps.resolveTarget(threadId);
        const token =
          deps.token?.(threadId) ?? String(++counter).padStart(20, "0");
        let before: Capture = {
          status: "not-captured",
          reason: "not an owned worktree",
        };
        if (target !== null) {
          try {
            before = await deps.capture(target, {
              threadId,
              token,
              phase: "before",
            });
          } catch {
            before = {
              status: "incomplete",
              reason: "baseline capture unavailable",
            };
          }
        }
        if ((generations.get(threadId) ?? 0) !== generation) return;
        pending.set(threadId, { requestId, target, token, before });
        if (pending.size > MAX_INTERVAL_RECORDS) {
          const first = pending.keys().next().value;
          if (first !== undefined) pending.delete(first);
        }
      })();
      preparing.set(threadId, work);
      try {
        await work;
      } finally {
        preparing.delete(threadId);
      }
    },
    abandon(threadId: string, requestId: string): void {
      if (pending.get(threadId)?.requestId === requestId)
        pending.delete(threadId);
    },
    started(threadId: string, turnId: string): void {
      if (!deps.enabled() || records.has(key(threadId, turnId))) return;
      generations.set(threadId, (generations.get(threadId) ?? 0) + 1);
      const baseline = pending.get(threadId) ?? null;
      pending.delete(threadId);
      running.set(threadId, turnId);
      records.set(key(threadId, turnId), {
        threadId,
        pending: baseline,
        done: false,
        result:
          baseline === null
            ? absent("not-captured", "no baseline captured before this turn")
            : baseline.before.status === "captured"
              ? absent("incomplete", "turn has not ended")
              : absent(baseline.before.status, baseline.before.reason),
      });
      limitRecords(threadId);
    },
    async completed(threadId: string, turnId: string): Promise<void> {
      if (!deps.enabled()) return;
      const inFlight = completing.get(threadId);
      if (inFlight) {
        await inFlight;
        return;
      }
      const entry = records.get(key(threadId, turnId));
      if (!entry) {
        if (running.get(threadId) === turnId) running.delete(threadId);
        return;
      }
      if (entry.done) return;
      entry.done = true;
      const work = (async () => {
        try {
          const baseline = entry.pending;
          if (!baseline?.target || baseline.before.status !== "captured")
            return;
          const current = deps.resolveTarget(threadId);
          if (
            current === null ||
            JSON.stringify(current) !== JSON.stringify(baseline.target)
          ) {
            entry.result = absent(
              "incomplete",
              "worktree ownership or location changed during the turn",
            );
            return;
          }
          const after = await deps.capture(current, {
            threadId,
            token: baseline.token,
            phase: "after",
          });
          const result =
            after.status === "captured"
              ? await deps.diff(current, baseline.before.tree, after.tree)
              : absent(after.status, after.reason);
          entry.result =
            JSON.stringify(deps.resolveTarget(threadId)) ===
            JSON.stringify(current)
              ? result
              : absent(
                  "incomplete",
                  "worktree ownership changed during end capture",
                );
        } catch {
          entry.result = absent(
            "incomplete",
            "end capture or diff unavailable",
          );
        } finally {
          entry.pending = null;
          if (running.get(threadId) === turnId) running.delete(threadId);
        }
      })();
      completing.set(threadId, work);
      try {
        await work;
      } finally {
        completing.delete(threadId);
      }
    },
    read(threadId: string, turnId: string): TurnSnapshotDiff {
      if (!deps.enabled())
        return absent("not-captured", "turn snapshot diff is disabled");
      return (
        records.get(key(threadId, turnId))?.result ??
        absent(
          "not-captured",
          "no retained capture for this turn; the server may have restarted",
        )
      );
    },
  };
}
type Coordinator = ReturnType<typeof createTurnSnapshotCoordinator>;
const coordinators = new WeakMap<WorkSessionDeps["db"], Coordinator>();
export function turnSnapshotsEnabled(): boolean {
  return process.env.BB_TURN_SNAPSHOT_DIFF?.trim() === "1";
}
export function threadTurnSnapshots(deps: WorkSessionDeps): Coordinator {
  let coordinator = coordinators.get(deps.db);
  if (coordinator) return coordinator;
  async function call(
    method: "captureTurnSnapshot" | "diffTurnSnapshots",
    target: Target,
    input: unknown,
  ) {
    const artifact = deps.pluginHostArtifacts.get(GIT_PLUGIN_ID);
    if (!artifact) throw new Error("Git host plugin is unavailable");
    return callPluginHostRpc(deps, {
      artifact,
      pluginId: GIT_PLUGIN_ID,
      contract: gitHostContract,
      method,
      input,
      hostId: target.hostId,
      timeoutMs: TURN_SNAPSHOT_MAX_MS + 1_000,
    });
  }
  coordinator = createTurnSnapshotCoordinator({
    enabled: turnSnapshotsEnabled,
    resolveTarget(threadId) {
      const thread = getThread(deps.db, threadId);
      const environment = thread?.environmentId
        ? getEnvironment(deps.db, thread.environmentId)
        : null;
      return environment
        ? ownedSnapshotTarget(
            threadId,
            environment,
            listThreadIdsInEnvironment(deps.db, environment.id),
          )
        : null;
    },
    token: (threadId) =>
      String(getLatestThreadSequence(deps.db, { threadId })).padStart(20, "0") +
      "-" +
      randomUUID(),
    capture: async (target, input) =>
      turnSnapshotCaptureSchema.parse(
        await call("captureTurnSnapshot", target, {
          path: target.path,
          branch: target.branch,
          repositoryPath: target.repositoryPath,
          ...input,
        }),
      ),
    diff: async (target, before, after) =>
      turnSnapshotDiffSchema.parse(
        await call("diffTurnSnapshots", target, {
          path: target.path,
          branch: target.branch,
          repositoryPath: target.repositoryPath,
          before,
          after,
        }),
      ),
  });
  coordinators.set(deps.db, coordinator);
  return coordinator;
}
export async function prepareTurnSnapshotCommand(
  deps: WorkSessionDeps,
  command: HostDaemonCommand,
): Promise<void> {
  if (!turnSnapshotsEnabled()) return;
  if (command.type !== "thread.start" && command.type !== "turn.submit") return;
  if (
    command.type === "turn.submit" &&
    (command.target.mode === "steer" ||
      (command.target.mode === "auto" &&
        command.target.expectedTurnId !== null))
  )
    return;
  await threadTurnSnapshots(deps).prepare(command.threadId, command.requestId);
}

export function abandonTurnSnapshotCommand(
  deps: WorkSessionDeps,
  command: HostDaemonCommand,
): void {
  if (!turnSnapshotsEnabled()) return;
  if (command.type === "thread.start" || command.type === "turn.submit") {
    threadTurnSnapshots(deps).abandon(command.threadId, command.requestId);
  }
}
