import {
  removeStartupMarker,
  writeStartupMarker,
} from "@bb/config/migration-info";

export type StartupStopSignal = "SIGINT" | "SIGTERM";

const STARTUP_STOP_SIGNALS: readonly StartupStopSignal[] = [
  "SIGINT",
  "SIGTERM",
];

export interface StartupSignalSource {
  on(signal: StartupStopSignal, listener: () => void): unknown;
  off(signal: StartupStopSignal, listener: () => void): unknown;
}

export interface StartupStopGuard {
  settle(): Promise<StartupStopSignal | null>;
  abandon(): void;
}

export interface DeferStopDuringDatabaseStartupArgs {
  logger: { info(fields: object, message: string): void };
  databasePath?: string;
  source?: StartupSignalSource;
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

export function deferStopDuringDatabaseStartup(
  args: DeferStopDuringDatabaseStartupArgs,
): StartupStopGuard {
  const source = args.source ?? process;
  const markerPath = args.databasePath;
  if (markerPath !== undefined) writeStartupMarker(markerPath);
  let requested: StartupStopSignal | null = null;
  const listeners = STARTUP_STOP_SIGNALS.map((signal) => {
    const listener = (): void => {
      if (requested === null) {
        args.logger.info(
          { signal },
          "Stop requested during database startup; finishing the migration before exiting",
        );
      }
      requested ??= signal;
    };
    source.on(signal, listener);
    return { signal, listener };
  });
  const detach = (): void => {
    if (markerPath !== undefined) removeStartupMarker(markerPath);
    for (const { signal, listener } of listeners) source.off(signal, listener);
  };
  return {
    async settle() {
      await yieldToEventLoop();
      await yieldToEventLoop();
      detach();
      return requested;
    },
    abandon: detach,
  };
}
