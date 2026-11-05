import { createRequire } from "node:module";

export const SESSION_SEARCH_MIN_SQLITE_VERSION = "3.43.0";

export type SessionSearchUnsupportedReason =
  | "binding-unavailable"
  | "sqlite-version-too-old"
  | "octet-length-unavailable"
  | "fts5-unavailable"
  | "probe-mismatch";

export type SessionSearchCapability =
  | { supported: true; sqliteVersion: string; indexingEnabled: true }
  | {
      supported: false;
      reason: SessionSearchUnsupportedReason;
      indexingEnabled: false;
    };

interface ProbeStatement {
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): unknown;
}

export interface ProbeDatabase {
  exec(sql: string): unknown;
  prepare(sql: string): ProbeStatement;
  close(): unknown;
}

export type ProbeDatabaseFactory = () => ProbeDatabase;

class ProbeStageError extends Error {
  constructor(readonly reason: SessionSearchUnsupportedReason) {
    super(reason);
  }
}

function openBetterSqlite3Memory(): ProbeDatabase {
  const require = createRequire(import.meta.url);
  const Database = require("better-sqlite3") as new (
    path: string,
  ) => ProbeDatabase;
  return new Database(":memory:");
}

function parseVersion(version: string): [number, number, number] | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (match === null) {
    return undefined;
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function versionAtLeast(version: string, minimum: string): boolean {
  const actual = parseVersion(version);
  const required = parseVersion(minimum);
  if (actual === undefined || required === undefined) {
    return false;
  }
  for (let index = 0; index < 3; index += 1) {
    const left = actual[index] ?? 0;
    const right = required[index] ?? 0;
    if (left !== right) {
      return left > right;
    }
  }
  return true;
}

function stage<T>(reason: SessionSearchUnsupportedReason, run: () => T): T {
  try {
    return run();
  } catch {
    throw new ProbeStageError(reason);
  }
}

function runProbe(db: ProbeDatabase): string {
  const versionRow = stage(
    "binding-unavailable",
    () => db.prepare("SELECT sqlite_version() AS version").get() as unknown,
  );
  const version =
    typeof versionRow === "object" &&
    versionRow !== null &&
    "version" in versionRow &&
    typeof versionRow.version === "string"
      ? versionRow.version
      : undefined;
  if (version === undefined) {
    throw new ProbeStageError("binding-unavailable");
  }
  if (!versionAtLeast(version, SESSION_SEARCH_MIN_SQLITE_VERSION)) {
    throw new ProbeStageError("sqlite-version-too-old");
  }

  const lengthRow = stage(
    "octet-length-unavailable",
    () => db.prepare("SELECT octet_length('é') AS length").get() as unknown,
  );
  if (
    typeof lengthRow !== "object" ||
    lengthRow === null ||
    !("length" in lengthRow) ||
    lengthRow.length !== 2
  ) {
    throw new ProbeStageError("octet-length-unavailable");
  }

  stage("fts5-unavailable", () =>
    db.exec("CREATE VIRTUAL TABLE session_search_probe USING fts5(text)"),
  );
  stage("fts5-unavailable", () => {
    db.prepare("INSERT INTO session_search_probe (text) VALUES (?)").run(
      "session search probe",
    );
  });
  const matchRow = stage(
    "fts5-unavailable",
    () =>
      db
        .prepare(
          "SELECT count(*) AS matches FROM session_search_probe WHERE session_search_probe MATCH ?",
        )
        .get("probe") as unknown,
  );
  if (
    typeof matchRow !== "object" ||
    matchRow === null ||
    !("matches" in matchRow) ||
    matchRow.matches !== 1
  ) {
    throw new ProbeStageError("probe-mismatch");
  }
  stage("fts5-unavailable", () => {
    db.prepare("DELETE FROM session_search_probe").run();
  });
  const remainingRow = stage(
    "fts5-unavailable",
    () =>
      db
        .prepare("SELECT count(*) AS remaining FROM session_search_probe")
        .get() as unknown,
  );
  if (
    typeof remainingRow !== "object" ||
    remainingRow === null ||
    !("remaining" in remainingRow) ||
    remainingRow.remaining !== 0
  ) {
    throw new ProbeStageError("probe-mismatch");
  }
  return version;
}

function closeQuietly(db: ProbeDatabase): void {
  try {
    db.close();
  } catch {
    return;
  }
}

export function probeSessionSearchCapability(
  openDatabase: ProbeDatabaseFactory = openBetterSqlite3Memory,
): SessionSearchCapability {
  let db: ProbeDatabase;
  try {
    db = openDatabase();
  } catch {
    return {
      supported: false,
      reason: "binding-unavailable",
      indexingEnabled: false,
    };
  }
  try {
    const sqliteVersion = runProbe(db);
    return { supported: true, sqliteVersion, indexingEnabled: true };
  } catch (error) {
    const reason: SessionSearchUnsupportedReason =
      error instanceof ProbeStageError ? error.reason : "probe-mismatch";
    return { supported: false, reason, indexingEnabled: false };
  } finally {
    closeQuietly(db);
  }
}
