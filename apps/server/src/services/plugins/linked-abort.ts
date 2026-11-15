export interface LinkedAbort {
  readonly signal: AbortSignal;
  /** Removes the listeners added to the source signals. Idempotent. */
  dispose(): void;
}

/**
 * Combines a per-call signal with a long-lived signal without AbortSignal.any.
 *
 * AbortSignal.any registers every source signal in a Node-internal registry
 * whose cells are freed only when the source is collected, so a lifetime
 * source leaks one cell per call. This uses a per-call controller with abort
 * listeners on both sources, removed by dispose().
 */
export function linkAbortSignals(
  callerSignal: AbortSignal,
  lifetimeSignal: AbortSignal,
): LinkedAbort {
  const controller = new AbortController();
  const sources = [callerSignal, lifetimeSignal];
  const aborted = sources.find((source) => source.aborted);
  if (aborted !== undefined) {
    controller.abort(aborted.reason);
    return { signal: controller.signal, dispose() {} };
  }
  const listeners = sources.map((source) => {
    const onAbort = () => {
      dispose();
      controller.abort(source.reason);
    };
    source.addEventListener("abort", onAbort, { once: true });
    return { source, onAbort };
  });
  function dispose(): void {
    for (const { source, onAbort } of listeners) {
      source.removeEventListener("abort", onAbort);
    }
  }
  return { signal: controller.signal, dispose };
}
