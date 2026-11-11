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
const realClearTimeout = globalThis.clearTimeout;
const CLOCK_CHANGE_GRACE_MS = 500;

interface PendingEntry {
  cancel: () => void;
  scope: object;
}

interface InFlightEntry {
  clockEpoch: number;
  scope: object;
  startedFaked: boolean;
}

const pendingCancels = new Map<object, PendingEntry>();
const inFlightWork = new Map<Promise<void>, InFlightEntry>();
const liveScopes = new Set<object>();
let trackingEnabled = false;
let clockEpoch = 0;

function timersAreFaked(): boolean {
  return globalThis.setTimeout !== realSetTimeout;
}

function watchClockSwaps(): void {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "setTimeout");
  if (!descriptor?.configurable || descriptor.get) return;
  let current = globalThis.setTimeout;
  Object.defineProperty(globalThis, "setTimeout", {
    configurable: true,
    enumerable: descriptor.enumerable,
    get: () => current,
    set: (value: typeof setTimeout) => {
      current = value;
      clockEpoch += 1;
    },
  });
}

export function enableDeferredWorkTrackingForTesting(scope: object): void {
  if (!trackingEnabled) watchClockSwaps();
  trackingEnabled = true;
  liveScopes.add(scope);
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
    inFlightWork.set(running, {
      clockEpoch,
      scope: args.config,
      startedFaked: timersAreFaked(),
    });
    void running.finally(() => {
      inFlightWork.delete(running);
    });
  });
  if (clear) {
    pendingCancels.set(immediate, {
      cancel: () => clear(immediate),
      scope: args.config,
    });
  }
}

export function trackDeferredTimer(timer: NodeJS.Timeout, scope: object): void {
  if (!trackingEnabled) return;
  const clear = clearTimeout;
  pendingCancels.set(timer, { cancel: () => clear(timer), scope });
}

export function releaseDeferredTimer(timer: NodeJS.Timeout): void {
  pendingCancels.delete(timer);
}

export async function cancelAndAwaitDeferredWorkForTesting(
  scope: object,
): Promise<void> {
  liveScopes.delete(scope);
  const owned = (entryScope: object): boolean =>
    entryScope === scope || !liveScopes.has(entryScope);
  for (;;) {
    for (const [handle, entry] of pendingCancels) {
      if (!owned(entry.scope)) continue;
      entry.cancel();
      pendingCancels.delete(handle);
    }
    const fakedNow = timersAreFaked();
    const awaited: Promise<void>[] = [];
    let clockChanged = false;
    for (const [running, entry] of inFlightWork) {
      if (!owned(entry.scope)) continue;
      if (fakedNow || entry.startedFaked) {
        inFlightWork.delete(running);
        continue;
      }
      awaited.push(running);
      if (entry.clockEpoch !== clockEpoch) clockChanged = true;
    }
    if (awaited.length === 0) return;
    const settled = Promise.allSettled(awaited);
    if (!clockChanged) {
      await settled;
      continue;
    }
    let deadline: NodeJS.Timeout | undefined;
    const expired = await Promise.race([
      settled.then(() => false),
      new Promise<boolean>((resolve) => {
        deadline = realSetTimeout(() => resolve(true), CLOCK_CHANGE_GRACE_MS);
      }),
    ]);
    realClearTimeout(deadline);
    if (expired) {
      for (const running of awaited) inFlightWork.delete(running);
    }
  }
}
