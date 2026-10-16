export const EXIT_WHEN_PARENT_GONE_ENV = "BB_DESKTOP_EXIT_WHEN_PARENT_GONE";

const FORCE_KILL_DELAY_MS = 10_000;

interface ParentWatchStdin {
  once(event: "close" | "end", listener: () => void): unknown;
  resume(): unknown;
  unref?(): unknown;
}

interface ParentWatchOutput {
  on(event: "error", listener: (error: Error) => void): unknown;
}

interface InstallParentExitWatchArgs {
  env: NodeJS.ProcessEnv;
  forceKillDelayMs?: number;
  kill(signal: NodeJS.Signals): void;
  outputs?: ParentWatchOutput[];
  platform?: NodeJS.Platform;
  stdin: ParentWatchStdin;
}

export function installParentExitWatch(
  args: InstallParentExitWatchArgs,
): boolean {
  // On Windows process.kill terminates immediately and skips the launcher's
  // signal handlers, which would leave the server and daemon ports held.
  if (
    args.env[EXIT_WHEN_PARENT_GONE_ENV] !== "1" ||
    (args.platform ?? process.platform) === "win32"
  ) {
    return false;
  }

  // The output readers die with the desktop, so shutdown logging would raise
  // an unhandled EPIPE before asynchronous cleanup finishes.
  for (const output of args.outputs ?? []) {
    output.on("error", (error) => {
      if ((error as NodeJS.ErrnoException).code !== "EPIPE") {
        throw error;
      }
    });
  }

  let triggered = false;
  const handleParentGone = (): void => {
    if (triggered) {
      return;
    }
    triggered = true;
    args.kill("SIGTERM");
    setTimeout(() => {
      args.kill("SIGKILL");
    }, args.forceKillDelayMs ?? FORCE_KILL_DELAY_MS).unref();
  };

  args.stdin.once("end", handleParentGone);
  args.stdin.once("close", handleParentGone);
  args.stdin.resume();
  args.stdin.unref?.();
  return true;
}
