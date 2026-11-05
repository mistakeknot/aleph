import { describe, expect, it, vi } from "vitest";
import {
  probeSessionSearchCapability,
  type ProbeDatabase,
} from "./session-search-probe.js";

interface FakeOptions {
  version?: string;
  octetLength?: number;
  failExecFts?: boolean;
  failInsert?: boolean;
  matches?: number;
  remaining?: number;
  failClose?: boolean;
}

function fakeDatabase(options: FakeOptions = {}): {
  db: ProbeDatabase;
  close: ReturnType<typeof vi.fn>;
} {
  const close = vi.fn(() => {
    if (options.failClose === true) {
      throw new Error("close failed at /private/path");
    }
  });
  const db: ProbeDatabase = {
    exec: () => {
      if (options.failExecFts === true) {
        throw new Error("no such module: fts5 at /private/path");
      }
    },
    prepare: (sql: string) => ({
      run: () => {
        if (options.failInsert === true && sql.startsWith("INSERT")) {
          throw new Error("insert failed");
        }
      },
      get: () => {
        if (sql.includes("sqlite_version")) {
          return { version: options.version ?? "3.50.0" };
        }
        if (sql.includes("octet_length")) {
          return { length: options.octetLength ?? 2 };
        }
        if (sql.includes("MATCH")) {
          return { matches: options.matches ?? 1 };
        }
        return { remaining: options.remaining ?? 0 };
      },
    }),
    close,
  };
  return { db, close };
}

describe("probeSessionSearchCapability", () => {
  it("reports supported with the SQLite version on the real binding", () => {
    const result = probeSessionSearchCapability();

    expect(result.supported).toBe(true);
    if (result.supported) {
      expect(result.indexingEnabled).toBe(true);
      expect(result.sqliteVersion).toMatch(/^3\.\d+\.\d+/);
    }
  });

  it("reports supported and closes the database when every stage passes", () => {
    const { db, close } = fakeDatabase();

    const result = probeSessionSearchCapability(() => db);

    expect(result).toEqual({
      supported: true,
      sqliteVersion: "3.50.0",
      indexingEnabled: true,
    });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("reports binding-unavailable when the binding cannot be opened", () => {
    const result = probeSessionSearchCapability(() => {
      throw new Error(
        "Cannot find module '/home/user/secret/better_sqlite3.node'",
      );
    });

    expect(result).toEqual({
      supported: false,
      reason: "binding-unavailable",
      indexingEnabled: false,
    });
    expect(JSON.stringify(result)).not.toContain("/home/user");
  });

  it("reports sqlite-version-too-old below 3.43.0", () => {
    const { db, close } = fakeDatabase({ version: "3.42.9" });

    const result = probeSessionSearchCapability(() => db);

    expect(result).toEqual({
      supported: false,
      reason: "sqlite-version-too-old",
      indexingEnabled: false,
    });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("accepts exactly 3.43.0", () => {
    const { db } = fakeDatabase({ version: "3.43.0" });

    expect(probeSessionSearchCapability(() => db).supported).toBe(true);
  });

  it("reports octet-length-unavailable on a wrong byte length", () => {
    const { db } = fakeDatabase({ octetLength: 1 });

    expect(probeSessionSearchCapability(() => db)).toEqual({
      supported: false,
      reason: "octet-length-unavailable",
      indexingEnabled: false,
    });
  });

  it("reports fts5-unavailable when the virtual table cannot be created", () => {
    const { db } = fakeDatabase({ failExecFts: true });
    const result = probeSessionSearchCapability(() => db);

    expect(result).toEqual({
      supported: false,
      reason: "fts5-unavailable",
      indexingEnabled: false,
    });
    expect(JSON.stringify(result)).not.toContain("/private");
  });

  it("reports fts5-unavailable when insert fails", () => {
    const { db } = fakeDatabase({ failInsert: true });

    expect(probeSessionSearchCapability(() => db)).toMatchObject({
      supported: false,
      reason: "fts5-unavailable",
    });
  });

  it("reports probe-mismatch when the query result is wrong", () => {
    const { db } = fakeDatabase({ matches: 0 });

    expect(probeSessionSearchCapability(() => db)).toMatchObject({
      supported: false,
      reason: "probe-mismatch",
    });
  });

  it("reports probe-mismatch when delete leaves rows behind", () => {
    const { db } = fakeDatabase({ remaining: 1 });

    expect(probeSessionSearchCapability(() => db)).toMatchObject({
      supported: false,
      reason: "probe-mismatch",
    });
  });

  it("does not let a close failure change the verdict", () => {
    const { db } = fakeDatabase({ failClose: true });

    expect(probeSessionSearchCapability(() => db).supported).toBe(true);
  });
});

describe("session search probe startup wiring", () => {
  it("probes before the daemon app is created and never aborts startup", async () => {
    const { readFile } = await import("node:fs/promises");
    const { dirname, resolve } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const source = await readFile(
      resolve(dirname(fileURLToPath(import.meta.url)), "start-host-daemon.ts"),
      "utf8",
    );
    const probeIndex = source.indexOf("probeSessionSearchCapability()");
    const appIndex = source.indexOf("await createHostDaemonApp(");

    expect(probeIndex).toBeGreaterThan(0);
    expect(appIndex).toBeGreaterThan(probeIndex);
    expect(source).toContain("indexing disabled");
    expect(source).not.toContain("process.exit(1)\n    const sessionSearch");
  });
});
