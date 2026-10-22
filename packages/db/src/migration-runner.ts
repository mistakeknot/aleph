import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import {
  legacyMigrationChain,
  type LegacyMigrationChainEntry,
} from "./legacy-migration-chain.js";
import {
  classifyAgainstCompatLog,
  describeViolations,
  expectedCompatPair,
  MigrationStateUnknown,
  readCompatLog,
  readLedger,
  readMaxCompatCreatedAt,
  type CompatLogRow,
  type ExpectedCompatPair,
  type MigrationLedgerRow,
} from "./migration-ledger.js";
import {
  computeAlteredTables,
  expandWithForeignKeyNeighbours,
  guardPlan,
  nonFrozenUpstreamSteps,
  splitMigrationStatements,
  verifyFrozenSet,
} from "./migration-guard.js";
import {
  buildMigrationPlan,
  loadFrozenUpstream,
  loadMigrationPlanInput,
  MigrationPlanError,
  planStepPath,
  type FrozenUpstreamStep,
  type MigrationPlan,
  type MigrationPlanFolders,
  type MigrationPlanInput,
  type MigrationPlanStep,
} from "./migration-plan.js";

export interface AlignedMigrationPlan {
  folders: MigrationPlanFolders;
  input: MigrationPlanInput;
  frozen: readonly FrozenUpstreamStep[];
  plan: MigrationPlan;
  legacy: readonly LegacyMigrationChainEntry[];
}

export type MigrationStepKind = "ledger" | "mapped" | "absent";

export interface MigrationStepState {
  index: number;
  step: MigrationPlanStep;
  kind: MigrationStepKind;
}

export interface MigrationState {
  existing: boolean;
  steps: readonly MigrationStepState[];
  lastDone: number;
  mapped: readonly number[];
  deferredCleanup: readonly number[];
  skipLargeValues: readonly number[];
  reorderedCleanup: readonly number[];
  pending: readonly number[];
  needsWrite: boolean;
}

const DEFERRED_CLEANUP_TAGS = [
  "0015_good_lila_cheney",
  "0016_salty_arclight",
  "0017_terminal_session_runtime_state_honesty",
  "0018_natural_crusher_hogan",
];
const SKIP_LARGE_VALUES_TAGS = [
  "0030_popout_chat_experiments",
  "0031_mysterious_zaran",
  "0032_restore_event_large_values",
];
const REORDERED_CLEANUP_TAGS = [
  "0033_drop_cleanup_mode",
  "0034_drop_stop_requested_at",
  "0035_warm_kingpin",
];
const DROP_WORKFLOW_TABLES_TAG = "0029_drop_workflow_tables";

export function sqliteTableExists(
  sqlite: Database.Database,
  tableName: string,
): boolean {
  return (
    sqlite
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(tableName) !== undefined
  );
}

export function sqliteColumnExists(
  sqlite: Database.Database,
  tableName: string,
  columnName: string,
): boolean {
  const rows = sqlite.pragma(`table_info(${tableName})`);
  return (
    Array.isArray(rows) &&
    rows.some(
      (row) =>
        typeof row === "object" &&
        row !== null &&
        "name" in row &&
        row.name === columnName,
    )
  );
}

export function stageMigrationTempTables(
  sqlite: Database.Database,
  args: { existing: boolean; hostId: string | null },
): void {
  sqlite.exec(
    "CREATE TEMP TABLE IF NOT EXISTS bb_migration_existing_installation (existing INTEGER NOT NULL)",
  );
  sqlite.exec("DELETE FROM bb_migration_existing_installation");
  sqlite
    .prepare(
      "INSERT INTO bb_migration_existing_installation (existing) VALUES (?)",
    )
    .run(args.existing ? 1 : 0);
  sqlite.exec(
    "CREATE TEMP TABLE IF NOT EXISTS bb_migration_local_host (id TEXT PRIMARY KEY)",
  );
  sqlite.exec("DELETE FROM bb_migration_local_host");
  if (args.hostId) {
    sqlite
      .prepare("INSERT INTO bb_migration_local_host (id) VALUES (?)")
      .run(args.hostId);
  }
  sqlite.exec(
    "CREATE TEMP TABLE IF NOT EXISTS bb_migration_queued_message_groups (id TEXT PRIMARY KEY, group_with_next INTEGER NOT NULL)",
  );
  sqlite.exec("DELETE FROM bb_migration_queued_message_groups");
}

export function readPlanStepSql(
  folders: MigrationPlanFolders,
  step: Pick<MigrationPlanStep, "namespace" | "file" | "sha256">,
): string {
  const bytes = readFileSync(planStepPath(folders, step));
  if (createHash("sha256").update(bytes).digest("hex") !== step.sha256) {
    throw new MigrationPlanError(
      `Migration step ${step.namespace}:${step.file} changed after the plan was loaded`,
    );
  }
  return bytes.toString("utf8");
}

function buildGuardDatabase(
  folders: MigrationPlanFolders,
  steps: ReadonlyArray<
    Pick<MigrationPlanStep, "namespace" | "file" | "sha256">
  >,
): Database.Database {
  const sqlite = new Database(":memory:");
  try {
    sqlite.pragma("foreign_keys = OFF");
    stageMigrationTempTables(sqlite, { existing: false, hostId: null });
    for (const step of steps) {
      for (const statement of splitMigrationStatements(
        readPlanStepSql(folders, step),
      )) {
        sqlite.exec(statement);
      }
    }
    return sqlite;
  } catch (error) {
    sqlite.close();
    throw error;
  }
}

function computeGuardedTables(
  folders: MigrationPlanFolders,
  input: MigrationPlanInput,
  plan: MigrationPlan,
): string[] {
  const upstreamOnly = buildGuardDatabase(
    folders,
    input.upstream.map((step) => ({
      namespace: "upstream" as const,
      file: `${step.tag}.sql`,
      sha256: step.sha256,
    })),
  );
  try {
    const withAleph = buildGuardDatabase(folders, plan.steps);
    try {
      return [
        ...expandWithForeignKeyNeighbours(
          withAleph,
          computeAlteredTables(upstreamOnly, withAleph),
        ),
      ];
    } finally {
      withAleph.close();
    }
  } finally {
    upstreamOnly.close();
  }
}

export function loadAlignedMigrationPlan(
  folders: MigrationPlanFolders,
): AlignedMigrationPlan {
  const input = loadMigrationPlanInput(folders);
  const frozen = loadFrozenUpstream(folders);
  verifyFrozenSet(frozen, input);
  const plan = buildMigrationPlan(input);

  if (plan.steps.length < legacyMigrationChain.length) {
    throw new Error(
      `Migration plan has ${plan.steps.length} steps but the legacy chain has ${legacyMigrationChain.length}`,
    );
  }
  for (const legacy of legacyMigrationChain) {
    const step = plan.steps[legacy.idx];
    if (
      step === undefined ||
      legacy.target.namespace !== step.namespace ||
      legacy.target.id !== step.id
    ) {
      throw new Error(
        `Plan step ${step?.namespace}:${step?.id} does not match legacy entry ${legacy.idx} (${legacy.target.namespace}:${legacy.target.id})`,
      );
    }
    if (step.sha256 !== legacy.sha256) {
      throw new Error(
        `Plan step ${step.id} does not match the legacy hash for ${legacy.tag}`,
      );
    }
  }

  const readFileText = (path: string): string => readFileSync(path, "utf8");
  const guardedTables =
    nonFrozenUpstreamSteps(frozen, input).length > 0
      ? computeGuardedTables(folders, input, plan)
      : [];
  guardPlan({
    frozen,
    input,
    plan,
    guardedTables,
    readUpstreamSql: (tag) =>
      readFileText(join(folders.upstreamFolder, `${tag}.sql`)),
    readAlephSql: (id) => {
      const step = input.aleph.find((candidate) => candidate.id === id);
      if (step === undefined) {
        throw new MigrationPlanError(`Unknown Aleph step ${id}`);
      }
      return readFileText(join(folders.alephFolder, step.file));
    },
  });

  return { folders, input, frozen, plan, legacy: legacyMigrationChain };
}

function stepKey(namespace: string, id: string): string {
  return `${namespace}:${id}`;
}

function validateLedger(
  aligned: AlignedMigrationPlan,
  ledger: readonly MigrationLedgerRow[],
): Map<string, MigrationLedgerRow> {
  const known = new Map<string, string>();
  for (const step of aligned.plan.steps) {
    known.set(stepKey(step.namespace, step.id), step.sha256);
  }
  for (const step of aligned.plan.superseded) {
    known.set(stepKey(step.namespace, step.id), step.sha256);
  }
  const rows = new Map<string, MigrationLedgerRow>();
  const unknown: string[] = [];
  const drifted: string[] = [];
  for (const row of ledger) {
    const key = stepKey(row.namespace, row.tag);
    if (rows.has(key)) {
      throw new MigrationStateUnknown(
        `Migration ledger holds ${key} more than once`,
        [key],
      );
    }
    rows.set(key, row);
    const sha = known.get(key);
    if (sha === undefined) unknown.push(key);
    else if (sha !== row.sha256) drifted.push(key);
  }
  if (unknown.length > 0) {
    throw new MigrationStateUnknown(
      `Migration ledger lists steps this binary does not know (database is newer than this binary): ${unknown.join(", ")}`,
      unknown,
    );
  }
  if (drifted.length > 0) {
    throw new MigrationStateUnknown(
      `Migration ledger hash drift: ${drifted.join(", ")}`,
      drifted,
    );
  }
  for (const superseded of aligned.plan.superseded) {
    const supersededRow = rows.get(stepKey("upstream", superseded.id));
    const replacement = aligned.plan.steps.find(
      (step) =>
        step.namespace === "aleph" && step.id === superseded.supersededBy,
    );
    const replacementRow =
      replacement === undefined
        ? undefined
        : rows.get(stepKey(replacement.namespace, replacement.id));
    if ((supersededRow === undefined) !== (replacementRow === undefined)) {
      throw new MigrationStateUnknown(
        `Migration ledger has ${superseded.id} and ${superseded.supersededBy} out of step`,
        [superseded.id, superseded.supersededBy],
      );
    }
  }
  return rows;
}

function checkDuplicateCompatRows(
  pairs: readonly ExpectedCompatPair[],
  compat: readonly CompatLogRow[],
): void {
  for (const pair of pairs) {
    const hashes = new Set(
      compat
        .filter((row) => row.createdAt === pair.createdAt)
        .map((row) => row.hash),
    );
    if (hashes.size <= 1) continue;
    const accepted = new Set([pair.hash, ...pair.compatibleHashes]);
    if (![...hashes].every((hash) => accepted.has(hash))) {
      throw new MigrationStateUnknown(
        `Database migration history is incomplete. Compatibility log holds conflicting rows at ${pair.createdAt} for ${pair.tag}.`,
        [pair.tag],
      );
    }
  }
}

function tagIndexes(
  aligned: AlignedMigrationPlan,
  tags: readonly string[],
): number[] {
  return tags.map((tag) =>
    aligned.plan.steps.findIndex(
      (step) => step.namespace === "upstream" && step.id === tag,
    ),
  );
}

export function computeMigrationState(
  sqlite: Database.Database,
  aligned: AlignedMigrationPlan,
): MigrationState {
  const ledger = validateLedger(aligned, readLedger(sqlite));
  const compat = readCompatLog(sqlite);
  const pairs = aligned.legacy.map(expectedCompatPair);
  checkDuplicateCompatRows(pairs, compat);

  const steps: MigrationStepState[] = [];
  const violations: Array<{
    pair: ExpectedCompatPair;
    reason: "hash-mismatch" | "missing-created-at";
  }> = [];
  for (const [index, step] of aligned.plan.steps.entries()) {
    const hasLedgerRow = ledger.has(stepKey(step.namespace, step.id));
    const pair = pairs[index];
    if (pair === undefined) {
      steps.push({ index, step, kind: hasLedgerRow ? "ledger" : "absent" });
      continue;
    }
    const classification = classifyAgainstCompatLog(pair, compat);
    if (classification.kind === "match") {
      steps.push({ index, step, kind: hasLedgerRow ? "ledger" : "mapped" });
    } else if (hasLedgerRow || classification.reason === "hash-mismatch") {
      violations.push({ pair, reason: classification.reason });
      steps.push({ index, step, kind: "absent" });
    } else {
      steps.push({ index, step, kind: "absent" });
    }
  }

  const lastDone = steps.reduce(
    (last, state) => (state.kind === "absent" ? last : state.index),
    -1,
  );
  const done = (state: MigrationStepState | undefined): boolean =>
    state !== undefined && state.kind !== "absent";
  if (lastDone === -1 && (compat.length > 0 || ledger.size > 0)) {
    throw new MigrationStateUnknown(
      `Database migration history matches no migration step: ${compat.length} compatibility log rows, ${ledger.size} ledger rows`,
      [],
    );
  }

  const deferredIndexes = tagIndexes(aligned, DEFERRED_CLEANUP_TAGS);
  const deferredAbsent = deferredIndexes.filter(
    (index) => steps[index]?.kind === "absent",
  );
  const deferredGap = deferredAbsent.some((index) => index < lastDone);
  const deferredCleanup =
    lastDone >= 0 && deferredGap && sqliteTableExists(sqlite, "projects")
      ? deferredAbsent
      : [];

  const [index30, index31, index32] = tagIndexes(
    aligned,
    SKIP_LARGE_VALUES_TAGS,
  );
  const [index29] = tagIndexes(aligned, [DROP_WORKFLOW_TABLES_TAG]);
  const maxCompat = readMaxCompatCreatedAt(sqlite);
  const legacy29 = index29 === undefined ? undefined : pairs[index29];
  const skipLargeValues =
    lastDone >= 0 &&
    steps[index31]?.kind === "absent" &&
    steps[index32]?.kind === "absent" &&
    sqliteTableExists(sqlite, "events") &&
    !sqliteTableExists(sqlite, "event_large_values") &&
    (done(steps[index30]) ||
      (steps[index30]?.kind === "absent" &&
        legacy29 !== undefined &&
        maxCompat === legacy29.createdAt))
      ? [index30, index31, index32].filter(
          (index) => steps[index]?.kind === "absent",
        )
      : [];

  const handled = new Set<number>([...deferredCleanup, ...skipLargeValues]);
  const reorderedCleanup = tagIndexes(aligned, REORDERED_CLEANUP_TAGS).filter(
    (index) =>
      steps[index]?.kind === "absent" &&
      index < lastDone &&
      !handled.has(index),
  );
  for (const index of reorderedCleanup) handled.add(index);

  const gaps = steps.filter(
    (state) =>
      state.kind === "absent" &&
      state.index < lastDone &&
      !handled.has(state.index) &&
      !violations.some((violation) => violation.pair === pairs[state.index]),
  );
  const unresolvedGaps = gaps.filter(
    (state) => pairs[state.index] === undefined,
  );
  if (unresolvedGaps.length > 0) {
    throw new MigrationStateUnknown(
      `Database migration history is incomplete. Missing migration ledger rows: ${unresolvedGaps
        .map((state) => `${state.step.namespace}:${state.step.id}`)
        .join("; ")}.`,
      unresolvedGaps.map((state) => state.step.id),
    );
  }
  for (const gap of gaps) {
    const pair = pairs[gap.index];
    if (pair !== undefined) {
      violations.push({ pair, reason: "missing-created-at" });
    }
  }
  if (violations.length > 0) {
    throw new MigrationStateUnknown(
      describeViolations(
        violations,
        "Database migration history is incomplete.",
      ),
      violations.map((violation) => violation.pair.tag),
    );
  }

  const pending = steps
    .filter(
      (state) =>
        state.kind === "absent" &&
        state.index > lastDone &&
        !handled.has(state.index),
    )
    .map((state) => state.index);
  const mapped = steps
    .filter((state) => state.kind === "mapped")
    .map((state) => state.index);
  return {
    existing: lastDone >= 0 || compat.length > 0 || ledger.size > 0,
    steps,
    lastDone,
    mapped,
    deferredCleanup,
    skipLargeValues,
    reorderedCleanup,
    pending,
    needsWrite:
      mapped.length > 0 ||
      pending.length > 0 ||
      deferredCleanup.length > 0 ||
      skipLargeValues.length > 0 ||
      reorderedCleanup.length > 0,
  };
}

export function isStepPending(
  state: MigrationState,
  namespace: "upstream" | "aleph",
  id: string,
): boolean {
  const entry = state.steps.find(
    (candidate) =>
      candidate.step.namespace === namespace && candidate.step.id === id,
  );
  return entry !== undefined && state.pending.includes(entry.index);
}
