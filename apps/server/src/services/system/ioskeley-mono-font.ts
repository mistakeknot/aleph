import { createHash } from "node:crypto";
// oxlint-disable-next-line no-restricted-imports
import { existsSync } from "node:fs";
// oxlint-disable-next-line no-restricted-imports
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { inflateRawSync } from "node:zlib";
import type { ServerLogger } from "../../types.js";

export const IOSKELEY_MONO_RELEASE_VERSION = "v2.1.0";
export const IOSKELEY_MONO_ASSET_URL =
  "https://github.com/ahatem/IoskeleyMono/releases/download/v2.1.0/IoskeleyMono-Web.zip";
export const IOSKELEY_MONO_ASSET_SHA256 =
  "76944acea9d71c8546fb933a574bfb3e54e4b8ef4664be4384f536be7f4c8e45";
const IOSKELEY_MONO_ZIP_ENTRY_NAME = "WOFF2/IoskeleyMono-Regular.woff2";
const IOSKELEY_MONO_FONT_DIR_NAME = "fonts";
export const IOSKELEY_MONO_FONT_FILE_NAME = "ioskeley-mono.woff2";
const IOSKELEY_MONO_DOWNLOAD_TIMEOUT_MS = 15_000;

const ZIP_END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const ZIP_CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const ZIP_COMPRESSION_STORED = 0;
const ZIP_COMPRESSION_DEFLATE = 8;

export function resolveIoskeleyMonoFontPath(dataDir: string): string {
  return join(
    dataDir,
    IOSKELEY_MONO_FONT_DIR_NAME,
    IOSKELEY_MONO_FONT_FILE_NAME,
  );
}

export async function readIoskeleyMonoFont(
  dataDir: string,
): Promise<Buffer | null> {
  try {
    return await readFile(resolveIoskeleyMonoFontPath(dataDir));
  } catch {
    return null;
  }
}

function findEndOfCentralDirectory(zip: Buffer): number {
  for (let offset = zip.length - 22; offset >= 0; offset -= 1) {
    if (zip.readUInt32LE(offset) === ZIP_END_OF_CENTRAL_DIRECTORY_SIGNATURE) {
      return offset;
    }
  }
  throw new Error(
    "Ioskeley Mono asset: not a valid zip file (no end-of-central-directory record)",
  );
}

function extractZipEntry(zip: Buffer, entryName: string): Buffer {
  const eocdOffset = findEndOfCentralDirectory(zip);
  const entryCount = zip.readUInt16LE(eocdOffset + 10);
  let centralDirOffset = zip.readUInt32LE(eocdOffset + 16);
  for (let i = 0; i < entryCount; i += 1) {
    if (
      zip.readUInt32LE(centralDirOffset) !== ZIP_CENTRAL_DIRECTORY_SIGNATURE
    ) {
      throw new Error("Ioskeley Mono asset: malformed central directory entry");
    }
    const compressionMethod = zip.readUInt16LE(centralDirOffset + 10);
    const compressedSize = zip.readUInt32LE(centralDirOffset + 20);
    const nameLength = zip.readUInt16LE(centralDirOffset + 28);
    const extraLength = zip.readUInt16LE(centralDirOffset + 30);
    const commentLength = zip.readUInt16LE(centralDirOffset + 32);
    const localHeaderOffset = zip.readUInt32LE(centralDirOffset + 42);
    const name = zip
      .subarray(centralDirOffset + 46, centralDirOffset + 46 + nameLength)
      .toString("utf8");
    if (name === entryName) {
      const localNameLength = zip.readUInt16LE(localHeaderOffset + 26);
      const localExtraLength = zip.readUInt16LE(localHeaderOffset + 28);
      const dataStart =
        localHeaderOffset + 30 + localNameLength + localExtraLength;
      const compressed = zip.subarray(dataStart, dataStart + compressedSize);
      if (compressionMethod === ZIP_COMPRESSION_STORED) {
        return Buffer.from(compressed);
      }
      if (compressionMethod === ZIP_COMPRESSION_DEFLATE) {
        return inflateRawSync(compressed);
      }
      throw new Error(
        `Ioskeley Mono asset: unsupported zip compression method ${compressionMethod}`,
      );
    }
    centralDirOffset += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error(`Ioskeley Mono asset: entry '${entryName}' not found in zip`);
}

export interface EnsureIoskeleyMonoFontArgs {
  dataDir: string;
  logger: Pick<ServerLogger, "warn">;
  fetchFn?: typeof fetch;
  assetUrl?: string;
  expectedSha256?: string;
  zipEntryName?: string;
}

export async function ensureIoskeleyMonoFont(
  args: EnsureIoskeleyMonoFontArgs,
): Promise<void> {
  const destinationPath = resolveIoskeleyMonoFontPath(args.dataDir);
  if (existsSync(destinationPath)) {
    return;
  }
  const fetchImpl = args.fetchFn ?? fetch;
  const assetUrl = args.assetUrl ?? IOSKELEY_MONO_ASSET_URL;
  const expectedSha256 = args.expectedSha256 ?? IOSKELEY_MONO_ASSET_SHA256;
  const zipEntryName = args.zipEntryName ?? IOSKELEY_MONO_ZIP_ENTRY_NAME;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      IOSKELEY_MONO_DOWNLOAD_TIMEOUT_MS,
    );
    let response: Response;
    try {
      response = await fetchImpl(assetUrl, { signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) {
      throw new Error(
        `Ioskeley Mono asset download failed: ${response.status} ${response.statusText}`,
      );
    }
    const zipBuffer = Buffer.from(await response.arrayBuffer());
    const actualSha256 = createHash("sha256").update(zipBuffer).digest("hex");
    if (actualSha256 !== expectedSha256) {
      throw new Error(
        `Ioskeley Mono asset digest mismatch: expected ${expectedSha256}, got ${actualSha256}`,
      );
    }
    const fontBytes = extractZipEntry(zipBuffer, zipEntryName);
    await mkdir(dirname(destinationPath), { recursive: true });
    const partialPath = `${destinationPath}.partial`;
    await writeFile(partialPath, fontBytes, { mode: 0o644 });
    await rename(partialPath, destinationPath);
  } catch (error) {
    await rm(`${destinationPath}.partial`, { force: true });
    args.logger.warn(
      { err: error },
      "Could not fetch the Ioskeley Mono font; Thecla will use its fallback font stack",
    );
  }
}
