// Restart pacing for the processes the bb-app supervisor keeps alive.
//
// Design choice (bead mk-k5ues): restarts back off exponentially so a process
// that cannot start (a full disk, a bad config) is not respawned every second,
// and after a bounded run of consecutive failures the supervisor exits so the
// service manager restarts the whole unit.
//
// The defaults are chosen against systemd's start limit, which is 5 starts in
// 10 seconds by default, with RestartSec=2 on the bb unit. Ten failures with
// delays of 1, 2, 4, 8, 16, 32, 60, 60 and 60 seconds mean at least about
// four minutes pass between two exits of the supervisor, so the unit can never
// reach the start limit however fast each attempt fails.

export interface RestartPolicy {
  /** Delay after the first failure in a row. */
  initialDelayMs: number;
  /** Ceiling for the doubling delay. */
  maxDelayMs: number;
  /** Consecutive failures after which the supervisor gives up. */
  maxConsecutiveFailures: number;
  /** A run that stays up this long counts as healthy and resets the streak. */
  stableUptimeMs: number;
}

export const DEFAULT_RESTART_POLICY: RestartPolicy = {
  initialDelayMs: 1_000,
  maxConsecutiveFailures: 10,
  maxDelayMs: 60_000,
  stableUptimeMs: 60_000,
};

export const RESTART_MAX_FAILURES_ENV_NAME = "BB_APP_RESTART_MAX_FAILURES";
export const RESTART_MAX_DELAY_MS_ENV_NAME = "BB_APP_RESTART_MAX_DELAY_MS";
export const RESTART_STABLE_UPTIME_MS_ENV_NAME =
  "BB_APP_RESTART_STABLE_UPTIME_MS";

function readPositiveInteger(
  value: string | undefined,
  fallback: number,
): number {
  if (value === undefined || !/^\d+$/.test(value.trim())) {
    return fallback;
  }
  const parsed = Number(value.trim());
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function resolveRestartPolicy(
  env: Readonly<Record<string, string | undefined>>,
): RestartPolicy {
  const maxDelayMs = readPositiveInteger(
    env[RESTART_MAX_DELAY_MS_ENV_NAME],
    DEFAULT_RESTART_POLICY.maxDelayMs,
  );
  return {
    initialDelayMs: Math.min(DEFAULT_RESTART_POLICY.initialDelayMs, maxDelayMs),
    maxConsecutiveFailures: readPositiveInteger(
      env[RESTART_MAX_FAILURES_ENV_NAME],
      DEFAULT_RESTART_POLICY.maxConsecutiveFailures,
    ),
    maxDelayMs,
    stableUptimeMs: readPositiveInteger(
      env[RESTART_STABLE_UPTIME_MS_ENV_NAME],
      DEFAULT_RESTART_POLICY.stableUptimeMs,
    ),
  };
}

export interface RestartFailureOutcome {
  consecutiveFailures: number;
  delayMs: number;
  /** True when the failure budget is spent and the supervisor should exit. */
  exhausted: boolean;
}

export interface RestartBackoff {
  /** Records one failed run or failed start and says how long to wait. */
  recordFailure(): RestartFailureOutcome;
  /** Marks the moment a process became healthy. */
  recordHealthy(): void;
}

export interface CreateRestartBackoffArgs {
  now?: () => number;
  policy: RestartPolicy;
}

export function createRestartBackoff(
  args: CreateRestartBackoffArgs,
): RestartBackoff {
  const now = args.now ?? Date.now;
  let consecutiveFailures = 0;
  let healthySince: number | null = null;

  return {
    recordFailure(): RestartFailureOutcome {
      if (
        healthySince !== null &&
        now() - healthySince >= args.policy.stableUptimeMs
      ) {
        consecutiveFailures = 0;
      }
      healthySince = null;
      consecutiveFailures += 1;
      const delayMs = Math.min(
        args.policy.maxDelayMs,
        args.policy.initialDelayMs * 2 ** (consecutiveFailures - 1),
      );
      return {
        consecutiveFailures,
        delayMs,
        exhausted: consecutiveFailures >= args.policy.maxConsecutiveFailures,
      };
    },
    recordHealthy(): void {
      healthySince = now();
    },
  };
}
