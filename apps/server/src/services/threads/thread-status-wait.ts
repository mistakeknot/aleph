import type { ThreadStatus } from "@bb/domain";

export type ThreadStatusWaitOutcome = "matched" | "pending" | "unreachable";

interface ThreadStatusWaitCheckArgs {
  current: ThreadStatus;
  target: ThreadStatus;
}

/**
 * A thread in `error` will not become `idle` by waiting alone; it needs a
 * follow-up send to recover. Without this check a wait for idle on an errored
 * thread would sit out its entire budget instead of returning at once, and
 * the caller would have no way to tell "still working" from "will never get
 * there".
 */
export function isThreadStatusWaitUnreachable(
  args: ThreadStatusWaitCheckArgs,
): boolean {
  return args.target === "idle" && args.current === "error";
}

/**
 * The single decision a status-wait round makes: keep the long poll open, or
 * return the current status to the caller. `matched`/`unreachable` both stop
 * the round immediately; `pending` means the round should keep waiting for
 * the next thread change (or its own deadline).
 */
export function resolveThreadStatusWaitOutcome(
  args: ThreadStatusWaitCheckArgs,
): ThreadStatusWaitOutcome {
  if (args.current === args.target) return "matched";
  if (isThreadStatusWaitUnreachable(args)) return "unreachable";
  return "pending";
}
