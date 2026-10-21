export interface CoordinatorInput {
  title: string | null;
  parentThreadId: string | null;
  archivedAt: number | null;
  deletedAt: number | null;
}

export type CoordinatorVerdict =
  | { kind: "coordinator"; prefix: string }
  | {
      kind: "not-coordinator";
      reason: "deleted" | "archived" | "child" | "other-role" | "no-role-suffix";
    }
  | {
      kind: "no-coordinator-signal";
      reason:
        | "null-title"
        | "empty-prefix"
        | "unrecognized-suffix"
        | "unpiped-coordinator";
    };

const COORDINATOR_ROLE = "coordinator";

export function classifyCoordinator(
  input: CoordinatorInput,
): CoordinatorVerdict {
  if (input.deletedAt !== null) {
    return { kind: "not-coordinator", reason: "deleted" };
  }
  if (input.archivedAt !== null) {
    return { kind: "not-coordinator", reason: "archived" };
  }
  if (input.parentThreadId !== null) {
    return { kind: "not-coordinator", reason: "child" };
  }
  const title = input.title?.trim() ?? "";
  if (title.length === 0) {
    return { kind: "no-coordinator-signal", reason: "null-title" };
  }
  const pipeIndex = title.lastIndexOf("|");
  if (pipeIndex === -1) {
    return /\bcoordinator\b/i.test(title)
      ? { kind: "no-coordinator-signal", reason: "unpiped-coordinator" }
      : { kind: "not-coordinator", reason: "no-role-suffix" };
  }
  const prefix = title.slice(0, pipeIndex).trim();
  const role = title
    .slice(pipeIndex + 1)
    .trim()
    .toLowerCase();
  if (role === COORDINATOR_ROLE) {
    return prefix.length === 0
      ? { kind: "no-coordinator-signal", reason: "empty-prefix" }
      : { kind: "coordinator", prefix };
  }
  if (/^coordinator\b/.test(role)) {
    return { kind: "no-coordinator-signal", reason: "unrecognized-suffix" };
  }
  return { kind: "not-coordinator", reason: "other-role" };
}
