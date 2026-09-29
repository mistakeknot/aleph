import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ALEPH_FORK_MIGRATION_WHENS,
  AlephDataDirRefusedError,
  assertAlephDataDir,
  findAlephDataDirRefusal,
} from "../src/aleph-data-dir.js";

let homeDir: string;

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), "aleph-data-dir-"));
});

afterEach(() => {
  rmSync(homeDir, { force: true, recursive: true });
});

function writeMigrationHistory(dataDir: string, whens: number[]): void {
  mkdirSync(dataDir, { recursive: true });
  const database = new DatabaseSync(join(dataDir, "bb.db"));
  database.exec(
    "CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY, hash TEXT NOT NULL, created_at NUMERIC)",
  );
  for (const when of whens) {
    database
      .prepare("INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)")
      .run(`hash-${String(when)}`, when);
  }
  database.close();
}

function writeRuntimeFile(dataDir: string, version: string): void {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(
    join(dataDir, "bb-app-runtime.json"),
    JSON.stringify({
      entryPath: "/x",
      pid: 1,
      serverUrl: "http://127.0.0.1:1",
      startedAt: "2026-01-01T00:00:00.000Z",
      surface: "desktop",
      version,
    }),
  );
}

describe("Aleph data dir refusal (plan 8.2)", () => {
  it("pins the fork migration timestamps to the drizzle journal", () => {
    const journal: { entries: { tag: string; when: number }[] } = JSON.parse(
      readFileSync(
        new URL("../../db/drizzle/meta/_journal.json", import.meta.url),
        "utf8",
      ),
    );
    const whensByTag = new Map(journal.entries.map((e) => [e.tag, e.when]));
    expect(ALEPH_FORK_MIGRATION_WHENS).toEqual([
      whensByTag.get("0132_aromatic_alice"),
      whensByTag.get("0133_hot_joshua_kane"),
    ]);
  });

  it("accepts ~/.aleph, dev dirs and machine dirs that merely share the prefix", () => {
    for (const dir of [".aleph", ".bb-dev/x", ".bb-machines/host", ".bbx"]) {
      expect(
        findAlephDataDirRefusal({ dataDir: join(homeDir, dir), homeDir }),
      ).toBeNull();
    }
  });

  it("refuses ~/.bb and anything inside it, even when it does not exist yet", () => {
    for (const dir of [".bb", ".bb/nested/deeper"]) {
      expect(
        findAlephDataDirRefusal({ dataDir: join(homeDir, dir), homeDir }),
      ).toMatchObject({ reason: "inside_stock_bb_dir" });
    }
  });

  it("refuses the macOS stock Application Support directory", () => {
    expect(
      findAlephDataDirRefusal({
        dataDir: join(homeDir, "Library", "Application Support", "bb", "x"),
        homeDir,
      }),
    ).toMatchObject({ reason: "inside_stock_bb_dir" });
  });

  it("resolves symlinks before judging the path", () => {
    mkdirSync(join(homeDir, ".bb"), { recursive: true });
    symlinkSync(join(homeDir, ".bb"), join(homeDir, "innocent"));
    expect(
      findAlephDataDirRefusal({
        dataDir: join(homeDir, "innocent", "sub"),
        homeDir,
      }),
    ).toMatchObject({ reason: "inside_stock_bb_dir" });
  });

  it("refuses a directory whose DB journal lacks either fork migration", () => {
    const [first, second] = ALEPH_FORK_MIGRATION_WHENS;
    for (const whens of [[1, 2], [1, first], [1, second]]) {
      const dataDir = join(homeDir, `d-${whens.join("-")}`);
      writeMigrationHistory(dataDir, whens);
      expect(findAlephDataDirRefusal({ dataDir, homeDir })).toMatchObject({
        reason: "stock_bb_database",
      });
    }
  });

  it("accepts a fork DB, an empty DB and an absent DB", () => {
    const forkDir = join(homeDir, "fork");
    writeMigrationHistory(forkDir, [1, ...ALEPH_FORK_MIGRATION_WHENS]);
    const emptyDir = join(homeDir, "empty");
    writeMigrationHistory(emptyDir, []);
    const absentDir = join(homeDir, "absent");
    mkdirSync(absentDir);
    for (const dataDir of [forkDir, emptyDir, absentDir]) {
      expect(findAlephDataDirRefusal({ dataDir, homeDir })).toBeNull();
    }
  });

  it("refuses a directory holding a stock bb runtime file", () => {
    const dataDir = join(homeDir, "stock-runtime");
    writeRuntimeFile(dataDir, "0.44.0");
    expect(findAlephDataDirRefusal({ dataDir, homeDir })).toMatchObject({
      reason: "stock_bb_runtime_file",
    });
  });

  it("honors an unparseable runtime file as stock, since Aleph never writes an unparseable one", () => {
    const dataDir = join(homeDir, "junk-runtime");
    mkdirSync(dataDir);
    writeFileSync(join(dataDir, "bb-app-runtime.json"), "not json");
    expect(findAlephDataDirRefusal({ dataDir, homeDir })).toMatchObject({
      reason: "stock_bb_runtime_file",
    });
  });

  it("accepts Aleph and dev runtime files", () => {
    const alephDir = join(homeDir, "aleph-runtime");
    writeRuntimeFile(alephDir, "0.44.0+aleph.0.5.0");
    const devDir = join(homeDir, "dev-runtime");
    writeRuntimeFile(devDir, "0.0.0-dev");
    for (const dataDir of [alephDir, devDir]) {
      expect(findAlephDataDirRefusal({ dataDir, homeDir })).toBeNull();
    }
  });

  it("throws a typed error naming the reason and the directory", () => {
    const dataDir = join(homeDir, ".bb");
    let caught: unknown;
    try {
      assertAlephDataDir({ dataDir, homeDir });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AlephDataDirRefusedError);
    expect(String(caught)).toContain("inside_stock_bb_dir");
    expect(String(caught)).toContain(dataDir);
  });
});
