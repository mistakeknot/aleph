export const EXIT_WHEN_PARENT_GONE_ENV = "BB_DESKTOP_EXIT_WHEN_PARENT_GONE";

const FORCE_KILL_DELAY_MS = 10_000;

interface ParentWatchStdin {
  once(event: "close" | "end", listener: () => void): unknown;
  resume(): unknown;
}

interface InstallParentExitWatchArgs {
  env: NodeJS.ProcessEnv;
  forceKillDelayMs?: number;
  kill(signal: NodeJS.Signals): void;
  stdin: ParentWatchStdin;
}

export function installParentExitWatch(
  args: InstallParentExitWatchArgs,
): boolean {
  if (args.env[EXIT_WHEN_PARENT_GONE_ENV] !== "1") {
    return false;
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
  return true;
}
