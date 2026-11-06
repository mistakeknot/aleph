import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const BUILD_TIMEOUT_MS = 300_000;
const LOCK_POLL_MS = 100;

export interface GeneratedPrerequisite {
  readonly label: string;
  readonly packageDir: string;
  readonly script: string;
  readonly outputs: () => Promise<readonly string[]>;
}

export interface EnsureOptions {
  readonly timeoutMs?: number;
  readonly lockDir?: string;
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

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function lockIsStale(lockDir: string, staleMs: number): Promise<boolean> {
  const holder = Number(
    await readFile(join(lockDir, "pid"), "utf8").catch(() => ""),
  );
  if (Number.isInteger(holder) && holder > 0 && !processIsAlive(holder)) {
    return true;
  }
  try {
    return Date.now() - (await stat(lockDir)).mtimeMs > staleMs;
  } catch {
    return false;
  }
}

export async function withBuildLock<T>(
  lockDir: string,
  work: () => Promise<T>,
  options: { readonly waitMs: number; readonly staleMs: number },
): Promise<T> {
  const deadline = Date.now() + options.waitMs;
  for (;;) {
    try {
      await mkdir(lockDir);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
    }
    if (await lockIsStale(lockDir, options.staleMs)) {
      const retired = `${lockDir}.stale-${process.pid}-${Date.now()}`;
      await rename(lockDir, retired)
        .then(() => rm(retired, { recursive: true, force: true }))
        .catch(() => undefined);
      continue;
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for the build lock at ${lockDir}`);
    }
    await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
  }
  try {
    await writeFile(join(lockDir, "pid"), String(process.pid));
    return await work();
  } finally {
    await rm(lockDir, { recursive: true, force: true });
  }
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
  const lockDir =
    options.lockDir ??
    join(
      tmpdir(),
      `bb-test-prerequisite-${createHash("sha256")
        .update(`${root}\0${prerequisite.packageDir}`)
        .digest("hex")
        .slice(0, 16)}.lock`,
    );
  await withBuildLock(
    lockDir,
    async () => {
      if (!(await isMissing(prerequisite, root))) {
        return;
      }
      try {
        await execFileAsync(process.execPath, [prerequisite.script], {
          cwd: join(root, prerequisite.packageDir),
          timeout: timeoutMs,
        });
      } catch (error) {
        const reason =
          (error as { killed?: boolean }).killed === true
            ? `timed out after ${timeoutMs} ms`
            : String(error);
        throw new Error(
          `Could not build ${prerequisite.label} before the server tests: ${reason}`,
          { cause: error },
        );
      }
    },
    { waitMs: timeoutMs * 2, staleMs: timeoutMs + 60_000 },
  );
}

export default async function ensureTestPrerequisites(): Promise<void> {
  for (const prerequisite of GENERATED_PREREQUISITES) {
    await ensurePrerequisite(prerequisite, repoRoot);
  }
}
