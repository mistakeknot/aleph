import type { ServerLogger, ServerRuntimeConfig } from "../../types.js";
import { runtimeErrorLogFields } from "./error-log-fields.js";

interface DeferAfterResponseArgs {
  config: Pick<ServerRuntimeConfig, "isDevelopment">;
  context?: Record<string, boolean | number | string | null | undefined>;
  logger: Pick<ServerLogger, "warn">;
  name: string;
  work: () => Promise<void>;
}

const pendingCancels = new Map<object, () => void>();
const inFlightWork = new Set<Promise<void>>();

export function deferAfterResponse(args: DeferAfterResponseArgs): void {
  const clear = clearImmediate;
  const immediate = setImmediate(() => {
    pendingCancels.delete(immediate);
    const running = args.work().catch((error) => {
      args.logger.warn(
        {
          ...args.context,
          ...runtimeErrorLogFields(args.config, error),
        },
        `${args.name} failed`,
      );
    });
    inFlightWork.add(running);
    const settled = () => {
      inFlightWork.delete(running);
    };
    void running.then(settled, settled);
  });
  pendingCancels.set(immediate, () => clear(immediate));
}

export function trackDeferredTimer(timer: NodeJS.Timeout): void {
  const clear = clearTimeout;
  pendingCancels.set(timer, () => clear(timer));
}

export function releaseDeferredTimer(timer: NodeJS.Timeout): void {
  pendingCancels.delete(timer);
}

interface CancelAndAwaitDeferredWorkOptions {
  awaitInFlight: boolean;
}

export async function cancelAndAwaitDeferredWorkForTesting(
  options: CancelAndAwaitDeferredWorkOptions,
): Promise<void> {
  for (;;) {
    for (const cancel of pendingCancels.values()) cancel();
    pendingCancels.clear();
    if (!options.awaitInFlight || inFlightWork.size === 0) return;
    await Promise.allSettled([...inFlightWork]);
  }
}
