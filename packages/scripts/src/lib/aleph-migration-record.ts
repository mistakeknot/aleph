import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface JournalEntryRecord {
  breakpoints: boolean;
  idx: number;
  tag: string;
  when: number;
}

export interface SqlHashRecord {
  sha256: string;
  tag: string;
}

export interface JournalRecord {
  entries: JournalEntryRecord[];
  snapshotSha256: string;
  sqlSha256: SqlHashRecord[];
}

export interface MigrationRecord {
  connectDb: JournalRecord | null;
  db: JournalRecord;
  hostDaemonProtocolVersion: number;
  wireContractSha256: string;
}

export interface ComputeMigrationRecordArgs {
  includeConnectDb?: boolean;
  repoRoot: string;
}

export interface RecordComparison {
  differences: string[];
  identical: boolean;
}

export type Delivery = "auto" | "manual";

export type DeliveryReason =
  | "identical"
  | "incomplete-back-compat-evidence"
  | "no-predecessor"
  | "qualified-pair"
  | "unqualified-difference";

export interface DeliveryDecision {
  backCompat: boolean;
  delivery: Delivery;
  reason: DeliveryReason;
}

export interface QualifiedPairEndpoint {
  recordSha256: string;
  version: string;
}

export interface QualifiedPair {
  evidence: {
    backCompat: {
      afterReadyWrite: boolean;
      fresh: boolean;
      predecessorRecordSha256: string;
      successorRecordSha256: string;
    };
  };
  predecessor: QualifiedPairEndpoint;
  successor: QualifiedPairEndpoint;
}

export interface QualifiedPairs {
  pairs: QualifiedPair[];
  schema: 1;
}

export interface DeriveDeliveryArgs {
  pairs: QualifiedPairs;
  predecessor: MigrationRecord | null;
  successor: MigrationRecord;
}

export interface BackCompatCaseResult {
  failures: string[];
  ok: boolean;
}

export interface BackCompatCheckResult {
  afterReadyWrite: BackCompatCaseResult;
  backCompat: boolean;
  fresh: BackCompatCaseResult;
  predecessorAppliedMigrations: number;
  predecessorRecordSha256: string;
  successorAppliedMigrations: number;
  successorRecordSha256: string;
}

export interface RunBackCompatCheckArgs {
  includeConnectDb?: boolean;
  predecessorRoot: string;
  successorRoot: string;
  successorSchemaSabotage?: string;
  workDir: string;
}

export interface QualifyPairArgs {
  check: BackCompatCheckResult;
  predecessor: { record: MigrationRecord; version: string };
  successor: { record: MigrationRecord; version: string };
}

interface SuccessorProbeOutput {
  applied: number;
}

interface PredecessorProbeOutput {
  applied: number;
  failures: string[];
}

const dbMigrationsDir = join("packages", "db", "drizzle");
const connectDbMigrationsDir = join("packages", "connect-db", "migrations");
const protocolSourcePath = join(
  "packages",
  "host-daemon-contract",
  "src",
  "protocol.ts",
);
const wireContractSourceDir = join("packages", "host-daemon-contract", "src");
const readyWriteProjectName = "aleph-back-compat-ready-write";

function sha256Hex(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (isObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function parseJournalEntry(value: unknown, index: number): JournalEntryRecord {
  if (
    !isObject(value) ||
    typeof value.idx !== "number" ||
    typeof value.tag !== "string" ||
    typeof value.when !== "number" ||
    typeof value.breakpoints !== "boolean"
  ) {
    throw new Error(`Malformed migration journal entry at position ${index}.`);
  }
  return {
    idx: value.idx,
    tag: value.tag,
    when: value.when,
    breakpoints: value.breakpoints,
  };
}

function computeJournalRecord(migrationsDir: string): JournalRecord {
  const journalPath = join(migrationsDir, "meta", "_journal.json");
  const journal: unknown = JSON.parse(readFileSync(journalPath, "utf8"));
  if (!isObject(journal) || !Array.isArray(journal.entries)) {
    throw new Error(`Malformed migration journal: ${journalPath}`);
  }
  const entries = journal.entries.map(parseJournalEntry);
  const lastEntry = entries.at(-1);
  if (lastEntry === undefined) {
    throw new Error(`Empty migration journal: ${journalPath}`);
  }
  const snapshotName = `${String(lastEntry.idx).padStart(4, "0")}_snapshot.json`;

  return {
    entries,
    sqlSha256: entries.map((entry) => ({
      tag: entry.tag,
      sha256: sha256Hex(readFileSync(join(migrationsDir, `${entry.tag}.sql`))),
    })),
    snapshotSha256: sha256Hex(
      readFileSync(join(migrationsDir, "meta", snapshotName)),
    ),
  };
}

function readProtocolVersion(repoRoot: string): number {
  const source = readFileSync(join(repoRoot, protocolSourcePath), "utf8");
  const match = /HOST_DAEMON_PROTOCOL_VERSION\s*=\s*(\d+)/u.exec(source);
  if (match?.[1] === undefined) {
    throw new Error("HOST_DAEMON_PROTOCOL_VERSION not found in protocol.ts.");
  }
  return Number(match[1]);
}

function listSourceFiles(dir: string, prefix = ""): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      return entry.isDirectory()
        ? listSourceFiles(join(dir, entry.name), relative)
        : [relative];
    });
}

function computeWireContractSha256(repoRoot: string): string {
  const sourceDir = join(repoRoot, wireContractSourceDir);
  const hash = createHash("sha256");
  for (const file of listSourceFiles(sourceDir)) {
    hash.update(`${file}\0${sha256Hex(readFileSync(join(sourceDir, file)))}\n`);
  }
  return hash.digest("hex");
}

export function computeMigrationRecord({
  includeConnectDb = false,
  repoRoot,
}: ComputeMigrationRecordArgs): MigrationRecord {
  return {
    db: computeJournalRecord(join(repoRoot, dbMigrationsDir)),
    connectDb: includeConnectDb
      ? computeJournalRecord(join(repoRoot, connectDbMigrationsDir))
      : null,
    hostDaemonProtocolVersion: readProtocolVersion(repoRoot),
    wireContractSha256: computeWireContractSha256(repoRoot),
  };
}

export function recordSha256(record: MigrationRecord): string {
  return sha256Hex(canonicalJson(record));
}

export function journalSha256(record: MigrationRecord): string {
  return sha256Hex(
    canonicalJson({ db: record.db, connectDb: record.connectDb }),
  );
}

function compareJournals(
  label: string,
  predecessor: JournalRecord,
  successor: JournalRecord,
): string[] {
  const differences: string[] = [];
  if (canonicalJson(predecessor.entries) !== canonicalJson(successor.entries)) {
    differences.push(
      `${label}.entries differ (${predecessor.entries.length} -> ${successor.entries.length} entries)`,
    );
  }
  if (
    canonicalJson(predecessor.sqlSha256) !== canonicalJson(successor.sqlSha256)
  ) {
    differences.push(`${label}.sqlSha256 differ`);
  }
  if (predecessor.snapshotSha256 !== successor.snapshotSha256) {
    differences.push(`${label}.snapshotSha256 differ`);
  }
  return differences;
}

export function compareRecords(
  predecessor: MigrationRecord,
  successor: MigrationRecord,
): RecordComparison {
  const differences = compareJournals("db", predecessor.db, successor.db);

  if (predecessor.connectDb === null || successor.connectDb === null) {
    if (predecessor.connectDb !== successor.connectDb) {
      differences.push("connectDb journal present on only one side");
    }
  } else {
    differences.push(
      ...compareJournals(
        "connectDb",
        predecessor.connectDb,
        successor.connectDb,
      ),
    );
  }
  if (
    predecessor.hostDaemonProtocolVersion !==
    successor.hostDaemonProtocolVersion
  ) {
    differences.push(
      `hostDaemonProtocolVersion differs (${predecessor.hostDaemonProtocolVersion} -> ${successor.hostDaemonProtocolVersion})`,
    );
  }
  if (predecessor.wireContractSha256 !== successor.wireContractSha256) {
    differences.push("wireContractSha256 differs");
  }

  return { identical: differences.length === 0, differences };
}

function parseEndpoint(value: unknown, label: string): QualifiedPairEndpoint {
  if (
    !isObject(value) ||
    typeof value.version !== "string" ||
    typeof value.recordSha256 !== "string"
  ) {
    throw new Error(`Malformed qualified pair ${label}.`);
  }
  return { version: value.version, recordSha256: value.recordSha256 };
}

function parseQualifiedPair(value: unknown, index: number): QualifiedPair {
  if (!isObject(value)) {
    throw new Error(`Malformed qualified pair at position ${index}.`);
  }
  const evidence = value.evidence;
  const backCompat = isObject(evidence) ? evidence.backCompat : undefined;
  if (
    !isObject(backCompat) ||
    typeof backCompat.fresh !== "boolean" ||
    typeof backCompat.afterReadyWrite !== "boolean"
  ) {
    throw new Error(
      `Qualified pair at position ${index} lacks back_compat reverse-test evidence.`,
    );
  }
  if (
    typeof backCompat.predecessorRecordSha256 !== "string" ||
    typeof backCompat.successorRecordSha256 !== "string"
  ) {
    throw new Error(
      `Qualified pair at position ${index} has back_compat evidence without predecessor and successor record hashes.`,
    );
  }
  const predecessor = parseEndpoint(value.predecessor, `${index}.predecessor`);
  const successor = parseEndpoint(value.successor, `${index}.successor`);
  if (
    backCompat.predecessorRecordSha256 !== predecessor.recordSha256 ||
    backCompat.successorRecordSha256 !== successor.recordSha256
  ) {
    throw new Error(
      `Qualified pair at position ${index}: back_compat evidence record hashes do not match the entry's predecessor and successor.`,
    );
  }
  return {
    predecessor,
    successor,
    evidence: {
      backCompat: {
        fresh: backCompat.fresh,
        afterReadyWrite: backCompat.afterReadyWrite,
        predecessorRecordSha256: backCompat.predecessorRecordSha256,
        successorRecordSha256: backCompat.successorRecordSha256,
      },
    },
  };
}

export function parseQualifiedPairs(value: unknown): QualifiedPairs {
  if (!isObject(value) || value.schema !== 1 || !Array.isArray(value.pairs)) {
    throw new Error(
      "qualified-pairs.json must be { schema: 1, pairs: [...] }.",
    );
  }
  return { schema: 1, pairs: value.pairs.map(parseQualifiedPair) };
}

export function deriveDelivery({
  pairs,
  predecessor,
  successor,
}: DeriveDeliveryArgs): DeliveryDecision {
  if (predecessor === null) {
    return { delivery: "manual", backCompat: false, reason: "no-predecessor" };
  }
  if (compareRecords(predecessor, successor).identical) {
    return { delivery: "auto", backCompat: true, reason: "identical" };
  }

  const predecessorSha = recordSha256(predecessor);
  const successorSha = recordSha256(successor);
  const pair = pairs.pairs.find(
    (candidate) =>
      candidate.predecessor.recordSha256 === predecessorSha &&
      candidate.successor.recordSha256 === successorSha,
  );
  if (pair === undefined) {
    return {
      delivery: "manual",
      backCompat: false,
      reason: "unqualified-difference",
    };
  }
  const { backCompat } = pair.evidence;
  if (
    !backCompat.fresh ||
    !backCompat.afterReadyWrite ||
    backCompat.predecessorRecordSha256 !== predecessorSha ||
    backCompat.successorRecordSha256 !== successorSha
  ) {
    return {
      delivery: "manual",
      backCompat: false,
      reason: "incomplete-back-compat-evidence",
    };
  }
  return { delivery: "auto", backCompat: true, reason: "qualified-pair" };
}

export function qualifyPair({
  check,
  predecessor,
  successor,
}: QualifyPairArgs): QualifiedPair {
  if (!check.backCompat || !check.fresh.ok || !check.afterReadyWrite.ok) {
    throw new Error(
      "Refusing to qualify a pair: the reverse back_compat test did not pass both cases.",
    );
  }
  const predecessorSha = recordSha256(predecessor.record);
  const successorSha = recordSha256(successor.record);
  if (check.predecessorRecordSha256 !== predecessorSha) {
    throw new Error(
      "Refusing to qualify a pair: the back_compat check was not run against this predecessor record.",
    );
  }
  if (check.successorRecordSha256 !== successorSha) {
    throw new Error(
      "Refusing to qualify a pair: the back_compat check was not run against this successor record.",
    );
  }
  return {
    predecessor: { version: predecessor.version, recordSha256: predecessorSha },
    successor: { version: successor.version, recordSha256: successorSha },
    evidence: {
      backCompat: {
        fresh: true,
        afterReadyWrite: true,
        predecessorRecordSha256: predecessorSha,
        successorRecordSha256: successorSha,
      },
    },
  };
}

const successorProbeSource = `
const args = JSON.parse(process.env.ALEPH_PROBE_ARGS);
const db = await import(args.moduleUrl);
const conn = db.createConnection(args.dbPath);
db.migrate(conn);
if (args.sabotage) conn.$client.exec(args.sabotage);
if (args.readyWrite) {
  const host = db.upsertHost(conn, db.noopNotifier, { name: "aleph-back-compat-host" });
  db.createProject(conn, db.noopNotifier, {
    name: args.projectName,
    source: { type: "local_path", hostId: host.id, path: "/tmp/aleph-back-compat" },
  });
}
process.stdout.write(JSON.stringify({ applied: db.countAppliedMigrations(conn) }));
if (!args.readyWrite) conn.$client.close();
process.exit(0);
`;

const predecessorProbeSource = `
const args = JSON.parse(process.env.ALEPH_PROBE_ARGS);
const db = await import(args.moduleUrl);
const failures = [];
const conn = db.createConnection(args.dbPath);
let applied = 0;
try {
  db.migrate(conn);
  applied = db.countAppliedMigrations(conn);
} catch (error) {
  failures.push("migrate: " + (error instanceof Error ? error.message : String(error)));
}
const sqlite = conn.$client;
const integrity = sqlite.pragma("integrity_check");
if (!(integrity.length === 1 && integrity[0].integrity_check === "ok")) {
  failures.push("integrity_check: " + JSON.stringify(integrity));
}
const violations = sqlite.pragma("foreign_key_check");
if (violations.length > 0) {
  failures.push("foreign_key_check: " + JSON.stringify(violations));
}
if (args.expectProjectName) {
  const row = sqlite
    .prepare("SELECT count(*) AS count FROM projects WHERE name = ?")
    .get(args.expectProjectName);
  if (row.count !== 1) {
    failures.push("ready-write project not readable: found " + row.count);
  }
}
process.stdout.write(JSON.stringify({ applied, failures }));
sqlite.close();
process.exit(0);
`;

function parseSuccessorProbeOutput(stdout: string): SuccessorProbeOutput {
  const parsed: unknown = JSON.parse(stdout);
  if (!isObject(parsed) || typeof parsed.applied !== "number") {
    throw new Error(`Unexpected successor probe output: ${stdout}`);
  }
  return { applied: parsed.applied };
}

function parsePredecessorProbeOutput(stdout: string): PredecessorProbeOutput {
  const parsed: unknown = JSON.parse(stdout);
  if (
    !isObject(parsed) ||
    typeof parsed.applied !== "number" ||
    !Array.isArray(parsed.failures) ||
    !parsed.failures.every((failure) => typeof failure === "string")
  ) {
    throw new Error(`Unexpected predecessor probe output: ${stdout}`);
  }
  return { applied: parsed.applied, failures: parsed.failures };
}

async function runProbe(
  root: string,
  source: string,
  args: Record<string, unknown>,
): Promise<string> {
  const moduleFile = join(root, "packages", "db", "src", "index.ts");
  if (!existsSync(moduleFile)) {
    throw new Error(`Missing @bb/db source at ${moduleFile}`);
  }
  const tsxLoader = pathToFileURL(
    createRequire(import.meta.url).resolve("tsx/esm"),
  ).href;
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      "--conditions=source",
      "--import",
      tsxLoader,
      "--input-type=module",
      "--eval",
      source,
    ],
    {
      cwd: join(root, "packages", "db"),
      env: {
        ...process.env,
        ALEPH_PROBE_ARGS: JSON.stringify({
          ...args,
          moduleUrl: pathToFileURL(moduleFile).href,
        }),
      },
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  return stdout;
}

async function runCase(
  args: RunBackCompatCheckArgs,
  caseName: "after-ready-write" | "fresh",
): Promise<{
  predecessor: PredecessorProbeOutput;
  result: BackCompatCaseResult;
  successor: SuccessorProbeOutput;
}> {
  const readyWrite = caseName === "after-ready-write";
  const caseDir = join(args.workDir, caseName);
  mkdirSync(caseDir, { recursive: true });
  const dbPath = join(caseDir, "bb.db");

  const successor = parseSuccessorProbeOutput(
    await runProbe(args.successorRoot, successorProbeSource, {
      dbPath,
      readyWrite,
      projectName: readyWriteProjectName,
      sabotage: args.successorSchemaSabotage ?? null,
    }),
  );
  const predecessor = parsePredecessorProbeOutput(
    await runProbe(args.predecessorRoot, predecessorProbeSource, {
      dbPath,
      expectProjectName: readyWrite ? readyWriteProjectName : null,
    }),
  );

  return {
    predecessor,
    successor,
    result: {
      ok: predecessor.failures.length === 0,
      failures: predecessor.failures,
    },
  };
}

export async function runBackCompatCheck(
  args: RunBackCompatCheckArgs,
): Promise<BackCompatCheckResult> {
  const recordArgs = { includeConnectDb: args.includeConnectDb ?? false };
  const predecessorRecordSha256 = recordSha256(
    computeMigrationRecord({ ...recordArgs, repoRoot: args.predecessorRoot }),
  );
  const successorRecordSha256 = recordSha256(
    computeMigrationRecord({ ...recordArgs, repoRoot: args.successorRoot }),
  );
  const fresh = await runCase(args, "fresh");
  const afterReadyWrite = await runCase(args, "after-ready-write");

  return {
    fresh: fresh.result,
    afterReadyWrite: afterReadyWrite.result,
    backCompat: fresh.result.ok && afterReadyWrite.result.ok,
    predecessorAppliedMigrations: fresh.predecessor.applied,
    predecessorRecordSha256,
    successorAppliedMigrations: fresh.successor.applied,
    successorRecordSha256,
  };
}
