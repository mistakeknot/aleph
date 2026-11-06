import { type ChildProcess, spawn } from "node:child_process";
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

function signalBuild(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    if (process.platform !== "win32" && child.pid !== undefined) {
      process.kill(-child.pid, signal);
    } else {
      child.kill(signal);
    }
  } catch {
    child.kill(signal);
  }
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
    let stderr = "";
    let timedOut = false;
    let forceKill: NodeJS.Timeout | undefined;
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-4000);
    });
    const deadline = setTimeout(() => {
      timedOut = true;
      signalBuild(child, "SIGTERM");
      forceKill = setTimeout(() => signalBuild(child, "SIGKILL"), killGraceMs);
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(deadline);
      clearTimeout(forceKill);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(deadline);
      clearTimeout(forceKill);
      resolve({ timedOut, code, stderr });
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

export default async function ensureTestPrerequisites(): Promise<void> {
  for (const prerequisite of GENERATED_PREREQUISITES) {
    await ensurePrerequisite(prerequisite, repoRoot);
  }
}
