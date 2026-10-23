import { open, readFile, truncate } from "node:fs/promises";
import { join } from "node:path";
import {
  durableMkdir,
  EVENT_ARCHIVE_DIRECTORY,
  EVENT_ARCHIVE_QUARANTINE_DIRECTORY,
  fsyncDirectory,
  sha256Hex,
} from "./segment-files.js";

export const COLD_MANIFEST_FILE = "manifest.jsonl";
export const COLD_MANIFEST_GENESIS_HASH = "0".repeat(64);

export const COLD_MANIFEST_ENTRY_KINDS = [
  "pending",
  "committed",
  "aborted",
  "rehydrated",
] as const;

export type ColdManifestEntryKind = (typeof COLD_MANIFEST_ENTRY_KINDS)[number];

export interface ColdManifestEntryInput {
  at: number;
  kind: ColdManifestEntryKind;
  reason?: string;
  segmentId: string;
  threadId: string;
}

export interface ColdManifestEntry extends ColdManifestEntryInput {
  hash: string;
  prev: string;
}

export class ColdManifestCorruptError extends Error {
  readonly lineNumber: number;

  constructor(lineNumber: number) {
    super(`Cold-tier manifest is corrupt at line ${lineNumber}`);
    this.name = "ColdManifestCorruptError";
    this.lineNumber = lineNumber;
  }
}

function entryHash(entry: Omit<ColdManifestEntry, "hash">): string {
  return sha256Hex(
    JSON.stringify({
      at: entry.at,
      kind: entry.kind,
      prev: entry.prev,
      reason: entry.reason ?? null,
      segmentId: entry.segmentId,
      threadId: entry.threadId,
    }),
  );
}

function parseEntry(line: string, prev: string): ColdManifestEntry | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const entry = value as ColdManifestEntry;
  if (
    typeof entry.at !== "number" ||
    !COLD_MANIFEST_ENTRY_KINDS.includes(entry.kind) ||
    typeof entry.segmentId !== "string" ||
    typeof entry.threadId !== "string" ||
    (entry.reason !== undefined && typeof entry.reason !== "string") ||
    entry.prev !== prev ||
    entry.hash !== entryHash(entry)
  ) {
    return null;
  }
  return entry;
}

export function coldManifestPath(dataDir: string): string {
  return join(dataDir, EVENT_ARCHIVE_DIRECTORY, COLD_MANIFEST_FILE);
}

async function readManifestBytes(dataDir: string): Promise<Buffer | null> {
  try {
    return await readFile(coldManifestPath(dataDir));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

interface ParsedManifest {
  entries: ColdManifestEntry[];
  tornTail: { offset: number; bytes: number } | null;
}

function parseManifest(bytes: Buffer): ParsedManifest {
  const entries: ColdManifestEntry[] = [];
  let prev = COLD_MANIFEST_GENESIS_HASH;
  let offset = 0;
  let lineNumber = 0;
  while (offset < bytes.length) {
    lineNumber += 1;
    const newline = bytes.indexOf(0x0a, offset);
    const end = newline === -1 ? bytes.length : newline;
    const entry =
      newline === -1
        ? null
        : parseEntry(bytes.subarray(offset, end).toString("utf8"), prev);
    if (entry === null) {
      const isFinalLine = newline === -1 || newline === bytes.length - 1;
      if (!isFinalLine) {
        throw new ColdManifestCorruptError(lineNumber);
      }
      return {
        entries,
        tornTail: { offset, bytes: bytes.length - offset },
      };
    }
    entries.push(entry);
    prev = entry.hash;
    offset = end + 1;
  }
  return { entries, tornTail: null };
}

export interface ColdManifestRecovery {
  entries: number;
  quarantinedPath: string | null;
  tornBytes: number;
}

export class ColdManifest {
  readonly dataDir: string;
  #lastHash = COLD_MANIFEST_GENESIS_HASH;
  #loaded = false;
  #stale = false;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
  }

  async recover(now: number): Promise<ColdManifestRecovery> {
    const bytes = await readManifestBytes(this.dataDir);
    if (bytes === null) {
      this.#lastHash = COLD_MANIFEST_GENESIS_HASH;
      this.#loaded = true;
      return { entries: 0, quarantinedPath: null, tornBytes: 0 };
    }
    const parsed = parseManifest(bytes);
    let quarantinedPath: string | null = null;
    if (parsed.tornTail !== null) {
      const quarantineDir = await durableMkdir(
        this.dataDir,
        EVENT_ARCHIVE_QUARANTINE_DIRECTORY,
      );
      quarantinedPath = join(quarantineDir, `manifest-tail-${now}.jsonl`);
      const handle = await open(quarantinedPath, "wx", 0o600);
      try {
        await handle.writeFile(bytes.subarray(parsed.tornTail.offset));
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fsyncDirectory(quarantineDir);
      await truncate(coldManifestPath(this.dataDir), parsed.tornTail.offset);
      const manifestHandle = await open(coldManifestPath(this.dataDir), "r+");
      try {
        await manifestHandle.sync();
      } finally {
        await manifestHandle.close();
      }
    }
    this.#lastHash = parsed.entries.at(-1)?.hash ?? COLD_MANIFEST_GENESIS_HASH;
    this.#loaded = true;
    this.#stale = false;
    return {
      entries: parsed.entries.length,
      quarantinedPath,
      tornBytes: parsed.tornTail?.bytes ?? 0,
    };
  }

  async append(input: ColdManifestEntryInput): Promise<ColdManifestEntry> {
    if (!this.#loaded) {
      throw new Error("Cold-tier manifest must be recovered before appending");
    }
    if (this.#stale) {
      await this.recover(input.at);
    }
    const archiveDir = await durableMkdir(
      this.dataDir,
      EVENT_ARCHIVE_DIRECTORY,
    );
    const withoutHash = {
      at: input.at,
      kind: input.kind,
      prev: this.#lastHash,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
      segmentId: input.segmentId,
      threadId: input.threadId,
    };
    const entry: ColdManifestEntry = {
      ...withoutHash,
      hash: entryHash(withoutHash),
    };
    const path = coldManifestPath(this.dataDir);
    this.#stale = true;
    const handle = await open(path, "a", 0o600);
    let created = false;
    try {
      created = (await handle.stat()).size === 0;
      await handle.writeFile(`${JSON.stringify(entry)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (created) {
      await fsyncDirectory(archiveDir);
    }
    this.#lastHash = entry.hash;
    this.#stale = false;
    return entry;
  }
}

export async function readColdManifestEntries(
  dataDir: string,
): Promise<ColdManifestEntry[]> {
  const bytes = await readManifestBytes(dataDir);
  return bytes === null ? [] : parseManifest(bytes).entries;
}

export async function snapshotColdManifestPrefix(
  dataDir: string,
  destinationPath: string,
): Promise<number> {
  const bytes = await readManifestBytes(dataDir);
  const end = bytes === null ? 0 : bytes.lastIndexOf(0x0a) + 1;
  const handle = await open(destinationPath, "w", 0o600);
  try {
    if (bytes !== null && end > 0) {
      await handle.writeFile(bytes.subarray(0, end));
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
  return end;
}
