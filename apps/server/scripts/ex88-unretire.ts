import { existsSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
import Database from "better-sqlite3";
import {
  abortTransferOperation,
  createConnection,
  getDowngradeReadiness,
  releaseAllWorkerClaimsOffline,
  type DbConnection,
  type DowngradeReadiness,
} from "@bb/db";

interface RedirectRow {
  sourceThreadId: string;
  successorThreadId: string | null;
  opId: string;
  projectId: string;
}

interface Quiesce {
  holders: number[];
  unverifiable: number;
}

interface Report {
  mode: "check" | "apply";
  schemaPresent: boolean;
  killSwitchOff: boolean;
  quiesce: Quiesce;
  stoppedBefore: string | null;
  before: DowngradeReadiness;
  workerClaimsReleased: number | null;
  redirectsToAbort: number;
  aborted: number;
  refusals: Array<{ opId: string; reason: string }>;
  after: DowngradeReadiness | null;
  ready: boolean;
}

const EMPTY_QUIESCE: Quiesce = { holders: [], unverifiable: 0 };

function killSwitchOff(): boolean {
  return process.env.ALEPH_TRANSFER_RETIRE === "off";
}

function findDatabaseHolders(path: string): Quiesce {
  const targets = new Set(
    [path, `${path}-wal`, `${path}-shm`]
      .filter((candidate) => existsSync(candidate))
      .map((candidate) => realpathSync(candidate)),
  );
  const holders: number[] = [];
  let unverifiable = 0;
  let pids: string[];
  try {
    pids = readdirSync("/proc").filter((name) => /^[0-9]+$/.test(name));
  } catch {
    return { holders, unverifiable: 1 };
  }
  for (const pid of pids) {
    if (Number(pid) === process.pid) continue;
    let descriptors: string[];
    try {
      descriptors = readdirSync(`/proc/${pid}/fd`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        unverifiable += 1;
      }
      continue;
    }
    for (const descriptor of descriptors) {
      try {
        if (targets.has(readlinkSync(`/proc/${pid}/fd/${descriptor}`))) {
          holders.push(Number(pid));
          break;
        }
      } catch {
        continue;
      }
    }
  }
  return { holders, unverifiable };
}

function parseArgs(argv: readonly string[]): {
  db: string;
  check: boolean;
  assumeStopped: boolean;
} {
  let db = "";
  let check = false;
  let assumeStopped = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--check") {
      check = true;
    } else if (arg === "--assume-stopped") {
      assumeStopped = true;
    } else if (arg === "--db") {
      db = argv[index + 1] ?? "";
      index += 1;
    } else {
      throw new Error(`unknown argument ${arg}`);
    }
  }
  if (db === "" || !existsSync(db)) {
    throw new Error("--db must name an existing database file");
  }
  return { db, check, assumeStopped };
}

function listRedirects(sqlite: Database.Database): RedirectRow[] {
  return sqlite
    .prepare(
      `SELECT r.source_thread_id AS sourceThreadId,
              r.successor_thread_id AS successorThreadId,
              r.op_id AS opId,
              o.project_id AS projectId
         FROM thread_redirects r
         JOIN transfer_operations o ON o.id = r.op_id
        ORDER BY o.created_at, r.source_thread_id`,
    )
    .all() as RedirectRow[];
}

function hasRetirementSchema(sqlite: Database.Database): boolean {
  const table = sqlite
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='thread_redirects'",
    )
    .get();
  if (table === undefined) {
    return false;
  }
  const columns = sqlite
    .prepare("SELECT name FROM pragma_table_info('queued_thread_messages')")
    .all() as Array<{ name: string }>;
  return columns.some((column) => column.name === "forward_source_row_id");
}

function legacyReport(mode: Report["mode"]): Report {
  const zero: DowngradeReadiness = {
    slots: 0,
    pendingEntries: 0,
    unemittedEvents: 0,
    redirects: 0,
    nullOrigins: 0,
    unackedReceipts: 0,
    ready: true,
  };
  return {
    mode,
    schemaPresent: false,
    killSwitchOff: killSwitchOff(),
    quiesce: EMPTY_QUIESCE,
    stoppedBefore: null,
    before: zero,
    workerClaimsReleased: null,
    redirectsToAbort: 0,
    aborted: 0,
    refusals: [],
    after: mode === "apply" ? zero : null,
    ready: true,
  };
}

function schemaPresent(path: string): boolean {
  const sqlite = new Database(path, { readonly: true });
  try {
    return hasRetirementSchema(sqlite);
  } finally {
    sqlite.close();
  }
}

function runCheck(path: string): Report {
  const sqlite = new Database(path, { readonly: true });
  try {
    const before = getDowngradeReadiness({
      $client: sqlite,
    } as unknown as DbConnection);
    return {
      mode: "check",
      schemaPresent: true,
      killSwitchOff: killSwitchOff(),
      quiesce: findDatabaseHolders(path),
      stoppedBefore: null,
      before,
      workerClaimsReleased: null,
      redirectsToAbort: listRedirects(sqlite).length,
      aborted: 0,
      refusals: [],
      after: null,
      ready: before.ready,
    };
  } finally {
    sqlite.close();
  }
}

function runApply(path: string, assumeStopped: boolean): Report {
  const quiesce = findDatabaseHolders(path);
  const db = createConnection(path);
  const report: Report = {
    mode: "apply",
    schemaPresent: true,
    killSwitchOff: killSwitchOff(),
    quiesce,
    stoppedBefore: null,
    before: getDowngradeReadiness(db),
    workerClaimsReleased: null,
    redirectsToAbort: 0,
    aborted: 0,
    refusals: [],
    after: null,
    ready: false,
  };
  const stop = (step: string): Report => {
    report.stoppedBefore = step;
    report.after = getDowngradeReadiness(db);
    return report;
  };
  try {
    if (!report.killSwitchOff) return stop("kill_switch");
    if (
      quiesce.holders.length > 0 ||
      (quiesce.unverifiable > 0 && !assumeStopped)
    ) {
      return stop("quiesce");
    }
    if (report.before.unemittedEvents > 0) return stop("undrained_events");

    report.workerClaimsReleased = releaseAllWorkerClaimsOffline(db).released;
    const redirects = listRedirects(db.$client);
    report.redirectsToAbort = redirects.length;
    for (const redirect of redirects) {
      const outcome = abortTransferOperation(db, {
        projectId: redirect.projectId,
        operationId: redirect.opId,
        expectedRetirementOperationId: redirect.opId,
        operationKey: `unretire:${redirect.opId}`,
        resolveWaitingOn: () => ({ kind: "thread-busy" }),
      });
      if (outcome.kind === "aborted" || outcome.kind === "replayed") {
        report.aborted += 1;
      } else {
        report.refusals.push({
          opId: redirect.opId,
          reason: outcome.kind === "refused" ? outcome.reason : outcome.kind,
        });
        return stop("abort");
      }
    }

    report.after = getDowngradeReadiness(db);
    report.ready = report.after.ready;
    if (!report.ready) {
      report.stoppedBefore =
        report.after.unemittedEvents > 0 || report.after.unackedReceipts > 0
          ? "undelivered_events"
          : "downgrade_ready";
    }
    return report;
  } finally {
    db.$client.close();
  }
}

const args = parseArgs(process.argv.slice(2));
const mode = args.check ? "check" : "apply";
const report = !schemaPresent(args.db)
  ? legacyReport(mode)
  : args.check
    ? runCheck(args.db)
    : runApply(args.db, args.assumeStopped);
console.log(JSON.stringify(report, null, 2));
process.exit(report.ready ? 0 : 1);
