import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  stat,
  unlink,
} from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { promisify } from "node:util";
import * as zlib from "node:zlib";
import { COLD_SEGMENT_READ_LIMIT } from "./config.js";

export const EVENT_ARCHIVE_DIRECTORY = "event-archive";
export const EVENT_ARCHIVE_STAGING_DIRECTORY = "event-archive-staging";
export const EVENT_ARCHIVE_QUARANTINE_DIRECTORY = "event-archive-quarantine";
export const COLD_SEGMENT_FILE_SUFFIX = ".jsonl.zst";
export const COLD_SEGMENT_ZSTD_LEVEL = 3;
export const STALE_STAGING_FILE_AGE_MS = 60 * 60 * 1000;

const SEGMENT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export class ColdSegmentReadError extends Error {
  readonly segmentId: string;

  constructor(segmentId: string, message: string) {
    super(`Cold segment ${segmentId} is unreadable: ${message}`);
    this.name = "ColdSegmentReadError";
    this.segmentId = segmentId;
  }
}

export function isZstdAvailable(): boolean {
  return (
    typeof zlib.zstdCompress === "function" &&
    typeof zlib.zstdDecompress === "function"
  );
}

function zstdCompress(input: Buffer): Promise<Buffer> {
  return promisify(zlib.zstdCompress)(input, {
    params: { [zlib.constants.ZSTD_c_compressionLevel]: COLD_SEGMENT_ZSTD_LEVEL },
  });
}

function zstdDecompress(input: Buffer, maxOutputLength: number): Promise<Buffer> {
  return promisify(zlib.zstdDecompress)(input, { maxOutputLength });
}

export function generateColdSegmentId(now: number): string {
  const bytes = randomBytes(16);
  const timestamp = BigInt(Math.max(0, Math.floor(now)));
  for (let index = 0; index < 6; index += 1) {
    bytes[index] = Number((timestamp >> BigInt(8 * (5 - index))) & 0xffn);
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function isColdSegmentId(value: string): boolean {
  return SEGMENT_ID_PATTERN.test(value);
}

export function coldSegmentRelativePath(
  threadId: string,
  segmentId: string,
): string {
  if (
    threadId.length === 0 ||
    threadId.includes("/") ||
    threadId.includes("\\") ||
    threadId.startsWith(".")
  ) {
    throw new Error(`Invalid thread id for cold segment path: ${threadId}`);
  }
  if (!isColdSegmentId(segmentId)) {
    throw new Error(`Invalid cold segment id: ${segmentId}`);
  }
  return [
    EVENT_ARCHIVE_DIRECTORY,
    threadId,
    `${segmentId}${COLD_SEGMENT_FILE_SUFFIX}`,
  ].join("/");
}

export function resolveDataDirPath(dataDir: string, relativePath: string): string {
  const resolved = join(dataDir, ...relativePath.split("/"));
  const back = relative(dataDir, resolved);
  if (back.startsWith("..") || back.split(sep).includes("..")) {
    throw new Error(`Path escapes the data dir: ${relativePath}`);
  }
  return resolved;
}

export async function fsyncDirectory(path: string): Promise<void> {
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function durableMkdir(
  dataDir: string,
  relativeDir: string,
): Promise<string> {
  let current = dataDir;
  for (const part of relativeDir.split("/").filter(Boolean)) {
    const parent = current;
    current = join(current, part);
    try {
      await mkdir(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        const info = await lstat(current);
        if (!info.isDirectory()) {
          throw new Error(`Expected a directory at ${current}`);
        }
        continue;
      }
      throw error;
    }
    await fsyncDirectory(current);
    await fsyncDirectory(parent);
  }
  return current;
}

export interface ColdSegmentHeader {
  bodyBytes: number;
  bodySha256: string;
  eventIds: string[];
  firstSequence: number;
  formatVersion: number;
  lastSequence: number;
  rowCount: number;
  segmentId: string;
  threadId: string;
  transformVersions: Record<string, number>;
}

export interface ColdSegmentFrame {
  decompressedBytes: number;
  frame: Buffer;
  headerBytes: number;
}

export function buildColdSegmentFrame(
  header: ColdSegmentHeader,
  body: Buffer,
): ColdSegmentFrame {
  if (body.length !== header.bodyBytes) {
    throw new Error("Cold segment body length does not match its header");
  }
  const headerLine = Buffer.from(`${JSON.stringify(header)}\n`, "utf8");
  return {
    decompressedBytes: headerLine.length + body.length,
    frame: Buffer.concat([headerLine, body]),
    headerBytes: headerLine.length,
  };
}

export interface WrittenColdSegmentFile {
  fileBytes: number;
  fileSha256: string;
  path: string;
}

export interface ColdSegmentFileFaults {
  afterStagingWrite?: () => void;
  afterPublish?: () => void;
}

export async function writeColdSegmentFile(args: {
  dataDir: string;
  faults?: ColdSegmentFileFaults;
  frame: ColdSegmentFrame;
  segmentId: string;
  threadId: string;
}): Promise<WrittenColdSegmentFile> {
  if (args.frame.decompressedBytes > COLD_SEGMENT_READ_LIMIT) {
    throw new Error("Cold segment frame exceeds the read limit");
  }
  const relativePath = coldSegmentRelativePath(args.threadId, args.segmentId);
  const compressed = await zstdCompress(args.frame.frame);
  if (compressed.length > COLD_SEGMENT_READ_LIMIT) {
    throw new Error("Compressed cold segment exceeds the read limit");
  }
  const stagingDir = await durableMkdir(
    args.dataDir,
    EVENT_ARCHIVE_STAGING_DIRECTORY,
  );
  const threadDir = await durableMkdir(
    args.dataDir,
    `${EVENT_ARCHIVE_DIRECTORY}/${args.threadId}`,
  );
  const stagingPath = join(stagingDir, `${args.segmentId}.tmp`);
  const finalPath = resolveDataDirPath(args.dataDir, relativePath);
  const handle = await open(stagingPath, "wx", 0o600);
  try {
    await handle.writeFile(compressed);
    await handle.sync();
  } finally {
    await handle.close();
  }
  args.faults?.afterStagingWrite?.();
  await link(stagingPath, finalPath);
  await unlink(stagingPath);
  await fsyncDirectory(threadDir);
  await fsyncDirectory(stagingDir);
  args.faults?.afterPublish?.();

  const readBack = await readExactFile(finalPath, compressed.length);
  if (!readBack.equals(compressed)) {
    throw new Error("Cold segment read-back does not match what was written");
  }
  const roundTrip = await zstdDecompress(readBack, args.frame.decompressedBytes);
  if (!roundTrip.equals(args.frame.frame)) {
    throw new Error("Cold segment does not decompress to its frame");
  }
  return {
    fileBytes: compressed.length,
    fileSha256: sha256Hex(compressed),
    path: relativePath,
  };
}

async function readExactFile(path: string, bytes: number): Promise<Buffer> {
  const handle = await open(path, "r");
  try {
    const info = await handle.stat();
    if (info.size !== bytes) {
      throw new Error(`Expected ${bytes} bytes at ${path}, found ${info.size}`);
    }
    const buffer = Buffer.alloc(bytes);
    let offset = 0;
    while (offset < bytes) {
      const { bytesRead } = await handle.read(buffer, offset, bytes - offset, offset);
      if (bytesRead === 0) {
        throw new Error(`Short read at ${path}`);
      }
      offset += bytesRead;
    }
    return buffer;
  } finally {
    await handle.close();
  }
}

export function sha256Hex(input: Buffer | string): string {
  return createHash("sha256").update(input).digest("hex");
}

export interface ColdSegmentReadTarget {
  bodySha256: string;
  decompressedBytes: number;
  fileBytes: number;
  fileSha256: string;
  headerBytes: number;
  path: string;
  segmentId: string;
  threadId: string;
}

export interface ReadColdSegment {
  body: Buffer;
  header: ColdSegmentHeader;
}

function isSafeNonNegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

export async function readColdSegmentFile(
  dataDir: string,
  target: ColdSegmentReadTarget,
): Promise<ReadColdSegment> {
  const fail = (message: string): never => {
    throw new ColdSegmentReadError(target.segmentId, message);
  };
  if (
    !isSafeNonNegativeInteger(target.fileBytes) ||
    !isSafeNonNegativeInteger(target.headerBytes) ||
    !isSafeNonNegativeInteger(target.decompressedBytes)
  ) {
    fail("segment sizes are not non-negative integers");
  }
  if (target.headerBytes >= target.decompressedBytes) {
    fail("header bytes are not below decompressed bytes");
  }
  if (
    target.decompressedBytes > COLD_SEGMENT_READ_LIMIT ||
    target.fileBytes > COLD_SEGMENT_READ_LIMIT
  ) {
    fail("segment exceeds the read limit");
  }
  if (target.path !== coldSegmentRelativePath(target.threadId, target.segmentId)) {
    fail("segment path does not match its identity");
  }
  const path = resolveDataDirPath(dataDir, target.path);
  let info;
  try {
    info = await stat(path);
  } catch (error) {
    return fail(`file missing (${(error as NodeJS.ErrnoException).code ?? "error"})`);
  }
  if (!info.isFile() || info.size !== target.fileBytes) {
    fail(`file size ${info.size} does not match ${target.fileBytes}`);
  }
  const compressed = await readExactFile(path, target.fileBytes).catch(
    (error: unknown) => fail(String(error)),
  );
  if (sha256Hex(compressed) !== target.fileSha256) {
    fail("file hash mismatch");
  }
  const frame = await zstdDecompress(compressed, target.decompressedBytes).catch(
    (error: unknown) => fail(`decompression failed: ${String(error)}`),
  );
  if (frame.length !== target.decompressedBytes) {
    fail("decompressed length mismatch");
  }
  if (frame[target.headerBytes - 1] !== 0x0a) {
    fail("header line length mismatch");
  }
  const headerLine = frame.subarray(0, target.headerBytes - 1);
  if (headerLine.includes(0x0a)) {
    fail("header line length mismatch");
  }
  let header: ColdSegmentHeader;
  try {
    header = JSON.parse(headerLine.toString("utf8")) as ColdSegmentHeader;
  } catch {
    return fail("header is not JSON");
  }
  const body = frame.subarray(target.headerBytes);
  if (header.bodyBytes !== body.length) {
    fail("body length mismatch");
  }
  if (
    header.segmentId !== target.segmentId ||
    header.threadId !== target.threadId
  ) {
    fail("header identity mismatch");
  }
  if (
    sha256Hex(body) !== target.bodySha256 ||
    header.bodySha256 !== target.bodySha256
  ) {
    fail("body hash mismatch");
  }
  return { body, header };
}

export async function cleanupStaleStagingFiles(
  dataDir: string,
  now: number,
): Promise<string[]> {
  const stagingDir = join(dataDir, EVENT_ARCHIVE_STAGING_DIRECTORY);
  let names: string[];
  try {
    names = await readdir(stagingDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const removed: string[] = [];
  for (const name of names.sort()) {
    if (!name.endsWith(".tmp")) {
      continue;
    }
    const path = join(stagingDir, name);
    const info = await lstat(path);
    if (!info.isFile() || now - info.mtimeMs < STALE_STAGING_FILE_AGE_MS) {
      continue;
    }
    await unlink(path);
    removed.push(name);
  }
  if (removed.length > 0) {
    await fsyncDirectory(stagingDir);
  }
  return removed;
}

export interface ColdArchiveFileEntry {
  bytes: number;
  path: string;
  segmentId: string;
  threadId: string;
}

export async function listColdArchiveFiles(
  dataDir: string,
): Promise<ColdArchiveFileEntry[]> {
  const root = join(dataDir, EVENT_ARCHIVE_DIRECTORY);
  let threadDirs;
  try {
    threadDirs = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const entries: ColdArchiveFileEntry[] = [];
  for (const threadDir of threadDirs) {
    if (!threadDir.isDirectory()) {
      continue;
    }
    const files = await readdir(join(root, threadDir.name), {
      withFileTypes: true,
    });
    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith(COLD_SEGMENT_FILE_SUFFIX)) {
        continue;
      }
      const segmentId = file.name.slice(0, -COLD_SEGMENT_FILE_SUFFIX.length);
      const info = await stat(join(root, threadDir.name, file.name));
      entries.push({
        bytes: info.size,
        path: [EVENT_ARCHIVE_DIRECTORY, threadDir.name, file.name].join("/"),
        segmentId,
        threadId: threadDir.name,
      });
    }
  }
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

