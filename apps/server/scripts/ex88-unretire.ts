import { existsSync } from "node:fs";
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

interface Report {
  mode: "check" | "apply";
  before: DowngradeReadiness;
  workerClaimsReleased: number | null;
  redirectsToAbort: number;
  aborted: number;
  refusals: Array<{ opId: string; reason: string }>;
  after: DowngradeReadiness | null;
  ready: boolean;
}

function parseArgs(argv: readonly string[]): { db: string; check: boolean } {
  let db = "";
  let check = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--check") {
      check = true;
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
  return { db, check };
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

function runCheck(path: string): Report {
  const sqlite = new Database(path, { readonly: true });
  try {
    const before = getDowngradeReadiness({
      $client: sqlite,
    } as unknown as DbConnection);
    return {
      mode: "check",
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

function runApply(path: string): Report {
  const db = createConnection(path);
  try {
    const before = getDowngradeReadiness(db);
    const released = releaseAllWorkerClaimsOffline(db);
    const redirects = listRedirects(db.$client);
    const refusals: Report["refusals"] = [];
    let aborted = 0;
    for (const redirect of redirects) {
      const outcome = abortTransferOperation(db, {
        projectId: redirect.projectId,
        operationId: redirect.opId,
        expectedRetirementOperationId: redirect.opId,
        operationKey: `unretire:${redirect.opId}`,
        resolveWaitingOn: () => ({ kind: "thread-busy" }),
      });
      if (outcome.kind === "aborted" || outcome.kind === "replayed") {
        aborted += 1;
      } else {
        refusals.push({
          opId: redirect.opId,
          reason: outcome.kind === "refused" ? outcome.reason : outcome.kind,
        });
      }
    }
    const after = getDowngradeReadiness(db);
    return {
      mode: "apply",
      before,
      workerClaimsReleased: released.released,
      redirectsToAbort: redirects.length,
      aborted,
      refusals,
      after,
      ready: after.ready && refusals.length === 0,
    };
  } finally {
    db.$client.close();
  }
}

const args = parseArgs(process.argv.slice(2));
const report = args.check ? runCheck(args.db) : runApply(args.db);
console.log(JSON.stringify(report, null, 2));
process.exit(report.ready ? 0 : 1);
