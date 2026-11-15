export interface LinkedAbort {
  readonly signal: AbortSignal;
  dispose(): void;
}

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
