import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { acquireFileLock } from "./file-lock.js";
import { isProcessRunning } from "./verified-process-stop.js";

const LOCK_FILE_NAME = ".lock";
const HOLDERS_DIR_NAME = ".lock-holders";

export type DataDirLockMode = "shared" | "exclusive";

const holderRecordSchema = z.object({
  bundlePath: z.string(),
  mode: z.enum(["shared", "exclusive"]),
  pid: z.number().int().positive(),
});

export type DataDirLockHolderRecord = z.infer<typeof holderRecordSchema>;

export interface DataDirLockHolder {
  bundlePath: string;
}

export interface AcquireDataDirLockArgs {
  dataDir: string;
  holder: DataDirLockHolder;
  mode: DataDirLockMode;
  timeoutMs: number;
}

export interface DataDirLock {
  release: () => Promise<void>;
}

export function formatDataDirLockPath(dataDir: string): string {
  return join(dataDir, LOCK_FILE_NAME);
}

export async function acquireDataDirLock(
  args: AcquireDataDirLockArgs,
): Promise<DataDirLock> {
  const lock = await acquireFileLock({
    path: formatDataDirLockPath(args.dataDir),
    shared: args.mode === "shared",
    timeoutMs: args.timeoutMs,
  });
  const holdersDir = join(args.dataDir, HOLDERS_DIR_NAME);
  const recordPath = join(
    holdersDir,
    `${String(process.pid)}-${randomUUID()}.json`,
  );
  try {
    mkdirSync(holdersDir, { recursive: true });
    const record: DataDirLockHolderRecord = {
      bundlePath: args.holder.bundlePath,
      mode: args.mode,
      pid: process.pid,
    };
    writeFileSync(recordPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  } catch (error) {
    await lock.release();
    throw error;
  }
  return {
    release: async () => {
      rmSync(recordPath, { force: true });
      await lock.release();
    },
  };
}

export function readDataDirLockHolders(
  dataDir: string,
  deps: { isProcessRunning: (pid: number) => boolean } = { isProcessRunning },
): DataDirLockHolderRecord[] {
  const holdersDir = join(dataDir, HOLDERS_DIR_NAME);
  let names: string[];
  try {
    names = readdirSync(holdersDir);
  } catch {
    return [];
  }
  const holders: DataDirLockHolderRecord[] = [];
  for (const name of names.sort()) {
    try {
      const record = holderRecordSchema.parse(
        JSON.parse(readFileSync(join(holdersDir, name), "utf8")),
      );
      if (deps.isProcessRunning(record.pid)) holders.push(record);
    } catch {}
  }
  return holders;
}
