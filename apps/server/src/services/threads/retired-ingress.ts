import {
  getThread,
  getThreadRedirectState,
  type DbQueryConnection,
} from "@bb/db";
import type { Thread } from "@bb/domain";
import type { ThreadNotWritableReason } from "@bb/server-contract";
import { retiredUserPostsMode } from "./retired-user-posts.js";

export const INGRESS_ADMISSION_ATTEMPTS = 3;

export class RetirementAppearedError extends Error {
  constructor(readonly threadId: string) {
    super(`Thread ${threadId} was retired while a message was in flight`);
    this.name = "RetirementAppearedError";
  }
}

export type RetiredIngressResolution =
  | { kind: "live"; thread: Thread }
  | { kind: "redirected"; thread: Thread }
  | { kind: "unavailable"; reason: ThreadNotWritableReason };

interface ResolveRetiredIngressOptions {
  refuseUserPosts: boolean;
}

export function resolveRetiredIngress(
  db: DbQueryConnection,
  thread: Thread,
  options: ResolveRetiredIngressOptions,
): RetiredIngressResolution {
  const state = getThreadRedirectState(db, thread.id);
  if (state.kind === "none") return { kind: "live", thread };
  if (state.successorThreadId === null) {
    return { kind: "unavailable", reason: "retired_no_successor" };
  }
  if (options.refuseUserPosts && retiredUserPostsMode() === "refuse") {
    return { kind: "unavailable", reason: "already_retired" };
  }
  if (getThreadRedirectState(db, state.successorThreadId).kind !== "none") {
    return { kind: "unavailable", reason: "redirect_depth_exceeded" };
  }
  const successor = getThread(db, state.successorThreadId);
  if (!successor || successor.deletedAt !== null) {
    return { kind: "unavailable", reason: "deleted" };
  }
  if (successor.archivedAt !== null) {
    return { kind: "unavailable", reason: "archived" };
  }
  return { kind: "redirected", thread: successor };
}

export function assertNotRetiredInTransaction(
  tx: DbQueryConnection,
  threadId: string,
): void {
  if (getThreadRedirectState(tx, threadId).kind !== "none") {
    throw new RetirementAppearedError(threadId);
  }
}

export function assertAdmittedDestinationInTransaction(
  tx: DbQueryConnection,
  requestedThreadId: string,
  admittedThreadId: string,
): void {
  const state = getThreadRedirectState(tx, requestedThreadId);
  const current =
    state.kind === "none" ? requestedThreadId : state.successorThreadId;
  if (current !== admittedThreadId) {
    throw new RetirementAppearedError(requestedThreadId);
  }
}
