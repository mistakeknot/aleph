import type { ServerLogger, ServerRuntimeConfig } from "../../types.js";
import { runtimeErrorLogFields } from "./error-log-fields.js";

interface DeferAfterResponseArgs {
  config: Pick<ServerRuntimeConfig, "isDevelopment">;
  context?: Record<string, boolean | number | string | null | undefined>;
  logger: Pick<ServerLogger, "warn">;
  name: string;
  work: () => Promise<void>;
}

const realSetTimeout = globalThis.setTimeout;
const pendingCancels = new Map<object, () => void>();
const inFlightWork = new Map<Promise<void>, boolean>();
let trackingEnabled = false;

function timersAreFaked(): boolean {
  return globalThis.setTimeout !== realSetTimeout;
}

export function enableDeferredWorkTrackingForTesting(): void {
  trackingEnabled = true;
}

export function deferAfterResponse(args: DeferAfterResponseArgs): void {
  const clear = trackingEnabled ? clearImmediate : undefined;
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
    if (!trackingEnabled) return;
    inFlightWork.set(running, timersAreFaked());
    void running.finally(() => {
      inFlightWork.delete(running);
    });
  });
  if (clear) pendingCancels.set(immediate, () => clear(immediate));
}

export function trackDeferredTimer(timer: NodeJS.Timeout): void {
  if (!trackingEnabled) return;
  const clear = clearTimeout;
  pendingCancels.set(timer, () => clear(timer));
}

export function releaseDeferredTimer(timer: NodeJS.Timeout): void {
  pendingCancels.delete(timer);
}

export async function cancelAndAwaitDeferredWorkForTesting(): Promise<void> {
  for (;;) {
    for (const cancel of pendingCancels.values()) cancel();
    pendingCancels.clear();
    const fakedNow = timersAreFaked();
    for (const [running, startedFaked] of inFlightWork) {
      if (fakedNow || startedFaked) inFlightWork.delete(running);
    }
    if (inFlightWork.size === 0) return;
    await Promise.allSettled([...inFlightWork.keys()]);
  }
}
