export function createReplayGate(labels: readonly string[]) {
  const states = new Map(
    labels.map((label) => [
      label,
      {
        reached: false,
        released: false,
        reachedWaiters: new Set<() => void>(),
        releaseWaiters: new Set<() => void>(),
      },
    ]),
  );
  if (states.size !== labels.length)
    throw new Error("Duplicate replay gate label");
  let closed = false;
  function stateFor(label: string) {
    const state = states.get(label);
    if (!state) throw new Error(`Unknown replay gate label: ${label}`);
    return state;
  }
  function wait(waiters: Set<() => void>, signal?: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
      const finish = () => {
        cleanup();
        resolve();
      };
      const abort = () => {
        cleanup();
        reject(signal?.reason ?? new Error("Replay gate aborted"));
      };
      const cleanup = () => {
        waiters.delete(finish);
        signal?.removeEventListener("abort", abort);
      };
      if (signal?.aborted) {
        abort();
        return;
      }
      waiters.add(finish);
      signal?.addEventListener("abort", abort, { once: true });
    });
  }
  return {
    hasReached: (label: string) => stateFor(label).reached,
    isReleased: (label: string) => stateFor(label).released,
    async beforeEmit(label: string, signal?: AbortSignal) {
      if (closed) throw new Error("Replay gate closed");
      signal?.throwIfAborted();
      const state = stateFor(label);
      state.reached = true;
      for (const wake of [...state.reachedWaiters]) wake();
      if (!state.released) await wait(state.releaseWaiters, signal);
      if (closed) throw new Error("Replay gate closed");
    },
    async waitForReached(label: string, signal?: AbortSignal) {
      if (closed) throw new Error("Replay gate closed");
      signal?.throwIfAborted();
      const state = stateFor(label);
      if (!state.reached) await wait(state.reachedWaiters, signal);
      if (closed) throw new Error("Replay gate closed");
    },
    release(label: string) {
      const state = stateFor(label);
      if (state.released) return false;
      state.released = true;
      for (const wake of [...state.releaseWaiters]) wake();
      return true;
    },
    teardown() {
      closed = true;
      for (const state of states.values()) {
        for (const wake of [...state.reachedWaiters, ...state.releaseWaiters])
          wake();
      }
    },
  };
}
