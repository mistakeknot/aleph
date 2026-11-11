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
const CLOCK_CHANGE_GRACE_MS = 1500;
const WATCHED_SCHEDULERS = [
  "setTimeout",
  "setImmediate",
  "setInterval",
] as const;
const realSchedulers = WATCHED_SCHEDULERS.map((name) => globalThis[name]);

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
const CLOCK_WATCH_KEY = Symbol.for("aleph.deferredWork.clockWatch");

interface ClockWatch {
  epoch: number;
  waiters: Set<() => void>;
}

const clockWatch = ((globalThis as Record<symbol, ClockWatch | undefined>)[
  CLOCK_WATCH_KEY
] ??= { epoch: 0, waiters: new Set() });

function timersAreFaked(): boolean {
  return WATCHED_SCHEDULERS.some(
    (name, index) => globalThis[name] !== realSchedulers[index],
  );
}

function watchClockSwaps(): void {
  for (const name of WATCHED_SCHEDULERS) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
    if (!descriptor?.configurable || descriptor.get) continue;
    let current: unknown = globalThis[name];
    Object.defineProperty(globalThis, name, {
      configurable: true,
      enumerable: descriptor.enumerable,
      get: () => current,
      set: (value: unknown) => {
        current = value;
        clockWatch.epoch += 1;
        for (const notify of [...clockWatch.waiters]) notify();
      },
    });
  }
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
      clockEpoch: clockWatch.epoch,
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
    const waits: Promise<void>[] = [];
    for (const [running, entry] of inFlightWork) {
      if (!owned(entry.scope)) continue;
      if (fakedNow || entry.startedFaked) {
        inFlightWork.delete(running);
        continue;
      }
      waits.push(awaitBounded(running, entry));
    }
    if (waits.length === 0) return;
    await Promise.all(waits);
  }
}

function awaitBounded(
  running: Promise<void>,
  entry: InFlightEntry,
): Promise<void> {
  return new Promise((resolve) => {
    let deadline: NodeJS.Timeout | undefined;
    const finish = (): void => {
      clockWatch.waiters.delete(arm);
      realClearTimeout(deadline);
      resolve();
    };
    const arm = (): void => {
      if (deadline) return;
      deadline = realSetTimeout(() => {
        inFlightWork.delete(running);
        finish();
      }, CLOCK_CHANGE_GRACE_MS);
    };
    running.then(finish, finish);
    if (clockWatch.epoch !== entry.clockEpoch) arm();
    else clockWatch.waiters.add(arm);
  });
}
