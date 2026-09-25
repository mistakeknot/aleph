import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ensureIoskeleyMonoFont,
  resolveIoskeleyMonoFontPath,
} from "../../src/services/system/ioskeley-mono-font.js";

function buildZipFixture(entryName: string, contents: Buffer): Buffer {
  const compressed = deflateRawSync(contents);
  const nameBytes = Buffer.from(entryName, "utf8");
  const localHeader = Buffer.alloc(30);
  localHeader.writeUInt32LE(0x04034b50, 0);
  localHeader.writeUInt16LE(20, 4);
  localHeader.writeUInt16LE(0, 6);
  localHeader.writeUInt16LE(8, 8);
  localHeader.writeUInt16LE(0, 10);
  localHeader.writeUInt16LE(0, 12);
  localHeader.writeUInt32LE(0, 14);
  localHeader.writeUInt32LE(compressed.length, 18);
  localHeader.writeUInt32LE(contents.length, 22);
  localHeader.writeUInt16LE(nameBytes.length, 26);
  localHeader.writeUInt16LE(0, 28);

  const localHeaderOffset = 0;
  const localEntry = Buffer.concat([localHeader, nameBytes, compressed]);

  const centralHeader = Buffer.alloc(46);
  centralHeader.writeUInt32LE(0x02014b50, 0);
  centralHeader.writeUInt16LE(20, 4);
  centralHeader.writeUInt16LE(20, 6);
  centralHeader.writeUInt16LE(0, 8);
  centralHeader.writeUInt16LE(8, 10);
  centralHeader.writeUInt16LE(0, 12);
  centralHeader.writeUInt16LE(0, 14);
  centralHeader.writeUInt32LE(0, 16);
  centralHeader.writeUInt32LE(compressed.length, 20);
  centralHeader.writeUInt32LE(contents.length, 24);
  centralHeader.writeUInt16LE(nameBytes.length, 28);
  centralHeader.writeUInt16LE(0, 30);
  centralHeader.writeUInt16LE(0, 32);
  centralHeader.writeUInt16LE(0, 34);
  centralHeader.writeUInt16LE(0, 36);
  centralHeader.writeUInt32LE(0, 38);
  centralHeader.writeUInt32LE(localHeaderOffset, 42);
  const centralEntry = Buffer.concat([centralHeader, nameBytes]);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(centralEntry.length, 12);
  eocd.writeUInt32LE(localEntry.length, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([localEntry, centralEntry, eocd]);
}

const ENTRY_NAME = "WOFF2/IoskeleyMono-Regular.woff2";
const FONT_BYTES = Buffer.from("fake woff2 font bytes for testing purposes");
const ZIP_FIXTURE = buildZipFixture(ENTRY_NAME, FONT_BYTES);
const ZIP_FIXTURE_SHA256 = createHash("sha256")
  .update(ZIP_FIXTURE)
  .digest("hex");

function testLogger() {
  return { warn: vi.fn() };
}

describe("ensureIoskeleyMonoFont", () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "bb-ioskeley-font-test-"));
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it("downloads, verifies, and extracts the font on success", async () => {
    const fetchFn = vi.fn(
      async () => new Response(new Uint8Array(ZIP_FIXTURE), { status: 200 }),
    );
    const logger = testLogger();

    await ensureIoskeleyMonoFont({
      dataDir,
      logger,
      fetchFn,
      assetUrl: "https://example.test/IoskeleyMono-Web.zip",
      expectedSha256: ZIP_FIXTURE_SHA256,
      zipEntryName: ENTRY_NAME,
    });

    const written = await readFile(resolveIoskeleyMonoFontPath(dataDir));
    expect(written.equals(FONT_BYTES)).toBe(true);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("is idempotent and skips the network when the font already exists", async () => {
    const destinationPath = resolveIoskeleyMonoFontPath(dataDir);
    await mkdir(join(dataDir, "fonts"), { recursive: true });
    await writeFile(destinationPath, "already here");
    const fetchFn = vi.fn();

    await ensureIoskeleyMonoFont({
      dataDir,
      logger: testLogger(),
      fetchFn,
      assetUrl: "https://example.test/IoskeleyMono-Web.zip",
      expectedSha256: ZIP_FIXTURE_SHA256,
      zipEntryName: ENTRY_NAME,
    });

    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("leaves no font file and warns, never throwing, when the download fails", async () => {
    const fetchFn = vi.fn(
      async () => new Response(null, { status: 500, statusText: "Boom" }),
    );
    const logger = testLogger();

    await expect(
      ensureIoskeleyMonoFont({
        dataDir,
        logger,
        fetchFn,
        assetUrl: "https://example.test/IoskeleyMono-Web.zip",
        expectedSha256: ZIP_FIXTURE_SHA256,
        zipEntryName: ENTRY_NAME,
      }),
    ).resolves.toBeUndefined();

    await expect(
      readFile(resolveIoskeleyMonoFontPath(dataDir)),
    ).rejects.toThrow();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("leaves no font file and warns, never throwing, on a sha256 mismatch", async () => {
    const fetchFn = vi.fn(
      async () => new Response(new Uint8Array(ZIP_FIXTURE), { status: 200 }),
    );
    const logger = testLogger();

    await ensureIoskeleyMonoFont({
      dataDir,
      logger,
      fetchFn,
      assetUrl: "https://example.test/IoskeleyMono-Web.zip",
      expectedSha256: "0".repeat(64),
      zipEntryName: ENTRY_NAME,
    });

    await expect(
      readFile(resolveIoskeleyMonoFontPath(dataDir)),
    ).rejects.toThrow();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("leaves no font file and warns, never throwing, when offline", async () => {
    const fetchFn = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const logger = testLogger();

    await ensureIoskeleyMonoFont({
      dataDir,
      logger,
      fetchFn,
      assetUrl: "https://example.test/IoskeleyMono-Web.zip",
      expectedSha256: ZIP_FIXTURE_SHA256,
      zipEntryName: ENTRY_NAME,
    });

    await expect(
      readFile(resolveIoskeleyMonoFontPath(dataDir)),
    ).rejects.toThrow();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});
