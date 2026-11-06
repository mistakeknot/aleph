import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const BUILD_TIMEOUT_MS = 300_000;
export const KILL_GRACE_MS = 5_000;

export interface GeneratedPrerequisite {
  readonly label: string;
  readonly packageDir: string;
  readonly script: string;
  readonly outputs: () => Promise<readonly string[]>;
}

export interface EnsureOptions {
  readonly timeoutMs?: number;
  readonly killGraceMs?: number;
}

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));

interface RuntimeEntry {
  readonly output: string;
}

async function pluginSdkRuntimeOutputs(): Promise<string[]> {
  const packageRoot = join(repoRoot, "packages/plugin-sdk");
  const manifest = JSON.parse(
    await readFile(join(packageRoot, "package.json"), "utf8"),
  ) as { exports: Record<string, unknown> };
  const entriesModule = pathToFileURL(
    join(packageRoot, "scripts/runtime-entries.mjs"),
  ).href;
  const { runtimeEntries } = (await import(entriesModule)) as {
    runtimeEntries: (exports: Record<string, unknown>) => RuntimeEntry[];
  };
  return runtimeEntries(manifest.exports).map((entry) => entry.output);
}

export const GENERATED_PREREQUISITES: readonly GeneratedPrerequisite[] = [
  {
    label: "@bb/process-utils profile worker",
    packageDir: "packages/process-utils",
    script: "scripts/generate-profile-worker.mjs",
    outputs: async () => ["src/generated/profile-worker.ts"],
  },
  {
    label: "@get-bb/plugin-sdk runtime",
    packageDir: "packages/plugin-sdk",
    script: "scripts/build-runtime.mjs",
    outputs: pluginSdkRuntimeOutputs,
  },
];

export async function isMissing(
  prerequisite: GeneratedPrerequisite,
  root: string,
): Promise<boolean> {
  const outputs = await prerequisite.outputs();
  return outputs.some(
    (output) => !existsSync(join(root, prerequisite.packageDir, output)),
  );
}

export async function missingPrerequisites(
  prerequisites: readonly GeneratedPrerequisite[],
  root: string,
): Promise<GeneratedPrerequisite[]> {
  const missing: GeneratedPrerequisite[] = [];
  for (const prerequisite of prerequisites) {
    if (await isMissing(prerequisite, root)) {
      missing.push(prerequisite);
    }
  }
  return missing;
}

interface BuildOutcome {
  readonly timedOut: boolean;
  readonly code: number | null;
  readonly stderr: string;
}

const GROUP_POLL_MS = 25;
const GROUP_REAP_SLACK_MS = 2_000;

const activeGroups = new Set<number>();
let exitHooks: (() => void) | undefined;

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    if (process.platform !== "win32") {
      process.kill(-pid, signal);
    } else {
      process.kill(pid, signal);
    }
  } catch {
    return;
  }
}

function groupAlive(pid: number): boolean {
  if (process.platform === "win32") {
    return false;
  }
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function killActiveBuilds(): void {
  for (const pid of activeGroups) {
    signalGroup(pid, "SIGKILL");
  }
}

function installExitHooks(): void {
  if (exitHooks) {
    return;
  }
  const foreignRemovals = new Set<NodeJS.Signals>();
  const onExit = (): void => killActiveBuilds();
  const onSignal = (signal: NodeJS.Signals): void => {
    const handledElsewhere = foreignRemovals.delete(signal);
    killActiveBuilds();
    removeExitHooks();
    if (!handledElsewhere && process.listenerCount(signal) === 0) {
      process.kill(process.pid, signal);
    }
  };
  const onInterrupt = (): void => onSignal("SIGINT");
  const onTerminate = (): void => onSignal("SIGTERM");
  const onRemoval = (event: string | symbol, listener: unknown): void => {
    if (
      (event === "SIGINT" || event === "SIGTERM") &&
      listener !== onInterrupt &&
      listener !== onTerminate &&
      !foreignRemovals.has(event)
    ) {
      foreignRemovals.add(event);
      process.nextTick(() => {
        foreignRemovals.delete(event);
      });
    }
  };
  process.on("exit", onExit);
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onTerminate);
  process.on("removeListener", onRemoval);
  exitHooks = () => {
    process.off("removeListener", onRemoval);
    process.off("exit", onExit);
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onTerminate);
  };
}

function removeExitHooks(): void {
  exitHooks?.();
  exitHooks = undefined;
}

function trackGroup(pid: number): void {
  activeGroups.add(pid);
  installExitHooks();
}

function untrackGroup(pid: number): void {
  activeGroups.delete(pid);
  if (activeGroups.size === 0) {
    removeExitHooks();
  }
}

function waitForGroupExit(pid: number, limitMs: number): Promise<void> {
  const giveUpAt = Date.now() + limitMs;
  return new Promise((resolve) => {
    const poll = (): void => {
      if (!groupAlive(pid) || Date.now() >= giveUpAt) {
        resolve();
        return;
      }
      setTimeout(poll, GROUP_POLL_MS);
    };
    poll();
  });
}

function runBuild(
  prerequisite: GeneratedPrerequisite,
  root: string,
  timeoutMs: number,
  killGraceMs: number,
): Promise<BuildOutcome> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [prerequisite.script], {
      cwd: join(root, prerequisite.packageDir),
      detached: process.platform !== "win32",
      stdio: ["ignore", "ignore", "pipe"],
    });
    const pid = child.pid;
    if (pid !== undefined) {
      trackGroup(pid);
    }
    let stderr = "";
    let timedOut = false;
    let forceKill: NodeJS.Timeout | undefined;
    const escalate = (): void => {
      if (pid === undefined) {
        child.kill("SIGTERM");
        return;
      }
      signalGroup(pid, "SIGTERM");
      forceKill ??= setTimeout(() => signalGroup(pid, "SIGKILL"), killGraceMs);
    };
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-4000);
    });
    const deadline = setTimeout(() => {
      timedOut = true;
      escalate();
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(deadline);
      clearTimeout(forceKill);
      if (pid !== undefined) {
        untrackGroup(pid);
      }
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(deadline);
      const finish = (): void => {
        clearTimeout(forceKill);
        if (pid !== undefined) {
          untrackGroup(pid);
        }
        resolve({ timedOut, code, stderr });
      };
      if (pid === undefined || !groupAlive(pid)) {
        finish();
        return;
      }
      escalate();
      void waitForGroupExit(pid, killGraceMs + GROUP_REAP_SLACK_MS).then(
        finish,
      );
    });
  });
}

export async function ensurePrerequisite(
  prerequisite: GeneratedPrerequisite,
  root: string,
  options: EnsureOptions = {},
): Promise<void> {
  if (!(await isMissing(prerequisite, root))) {
    return;
  }
  const timeoutMs = options.timeoutMs ?? BUILD_TIMEOUT_MS;
  const outcome = await runBuild(
    prerequisite,
    root,
    timeoutMs,
    options.killGraceMs ?? KILL_GRACE_MS,
  ).catch((error: unknown) => ({
    timedOut: false,
    code: null,
    stderr: String(error),
  }));
  if (outcome.timedOut || outcome.code !== 0) {
    const reason = outcome.timedOut
      ? `timed out after ${timeoutMs} ms`
      : `exited with code ${outcome.code}: ${outcome.stderr}`;
    throw new Error(
      `Could not build ${prerequisite.label} before the server tests: ${reason}`,
    );
  }
}

export default async function ensureTestPrerequisites(): Promise<() => void> {
  for (const prerequisite of GENERATED_PREREQUISITES) {
    await ensurePrerequisite(prerequisite, repoRoot);
  }
  return killActiveBuilds;
}
