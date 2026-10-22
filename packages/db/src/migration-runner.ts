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
  ledgerTableExists,
  readLedger,
  readMaxCompatCreatedAt,
  type CompatLogRow,
  type ExpectedCompatPair,
  type MigrationLedgerRow,
} from "./migration-ledger.js";
import {
  computeAlteredTables,
  foldName,
  expandWithForeignKeyNeighbours,
  guardPlan,
  nonFrozenUpstreamSteps,
  splitMigrationStatements,
  statementIdentifiers,
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
  matchedHash: string | null;
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
): { sqlite: Database.Database; skipped: string[] } {
  const sqlite = new Database(":memory:");
  const skipped: string[] = [];
  try {
    sqlite.pragma("foreign_keys = OFF");
    stageMigrationTempTables(sqlite, { existing: false, hostId: null });
    for (const step of steps) {
      for (const statement of splitMigrationStatements(
        readPlanStepSql(folders, step),
      )) {
        try {
          sqlite.exec(statement);
        } catch (error) {
          if (
            step.namespace === "aleph" &&
            error instanceof Error &&
            /\bno such (table|column|index|view)\b|has no column named/i.test(
              error.message,
            )
          ) {
            skipped.push(statement);
            continue;
          }
          throw error;
        }
      }
    }
    return { sqlite, skipped };
  } catch (error) {
    sqlite.close();
    throw error;
  }
}

function tablesNamedBy(
  sqlite: Database.Database,
  statements: readonly string[],
): string[] {
  const existing = new Set(
    (
      sqlite
        .prepare(
          "SELECT name FROM sqlite_master WHERE type IN ('table', 'view')",
        )
        .all() as Array<{ name: string }>
    ).map((row) => foldName(row.name)),
  );
  return [
    ...new Set(
      statements
        .flatMap((statement) => statementIdentifiers(statement))
        .filter((name) => existing.has(name)),
    ),
  ];
}

function computeGuardedTables(
  folders: MigrationPlanFolders,
  frozen: readonly FrozenUpstreamStep[],
  input: MigrationPlanInput,
  plan: MigrationPlan,
): string[] {
  const frozenTags = new Set(frozen.map((step) => step.tag));
  const { sqlite: upstreamOnly } = buildGuardDatabase(
    folders,
    input.upstream
      .filter((step) => frozenTags.has(step.tag))
      .map((step) => ({
        namespace: "upstream" as const,
        file: `${step.tag}.sql`,
        sha256: step.sha256,
      })),
  );
  try {
    const { sqlite: withAleph, skipped } = buildGuardDatabase(
      folders,
      plan.steps.filter(
        (step) => step.namespace === "aleph" || frozenTags.has(step.id),
      ),
    );
    try {
      return [
        ...expandWithForeignKeyNeighbours(withAleph, [
          ...computeAlteredTables(upstreamOnly, withAleph),
          ...tablesNamedBy(upstreamOnly, skipped),
        ]),
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
      ? computeGuardedTables(folders, frozen, input, plan)
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
  const known = new Map<string, ReadonlySet<string>>();
  for (const [index, step] of aligned.plan.steps.entries()) {
    known.set(
      stepKey(step.namespace, step.id),
      new Set([
        step.sha256,
        ...(aligned.legacy[index]?.compatibleHashes ?? []),
      ]),
    );
  }
  for (const step of aligned.plan.superseded) {
    known.set(stepKey(step.namespace, step.id), new Set([step.sha256]));
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
    else if (!sha.has(row.sha256)) drifted.push(key);
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

  const ledgerHistory = ledger.size > 0 || ledgerTableExists(sqlite);
  const missingLedger: string[] = [];
  const steps: MigrationStepState[] = [];
  const violations: Array<{
    pair: ExpectedCompatPair;
    reason: "hash-mismatch" | "missing-created-at";
  }> = [];
  const compatHashCounts = new Map<string, number>();
  const countedCompatRows = new Set<string>();
  for (const row of compat) {
    if (row.createdAt === null) continue;
    const rowKey = `${row.createdAt}:${row.hash}`;
    if (countedCompatRows.has(rowKey)) continue;
    countedCompatRows.add(rowKey);
    compatHashCounts.set(row.hash, (compatHashCounts.get(row.hash) ?? 0) + 1);
  }
  const datedCompatRows = compat.filter((row) => row.createdAt !== null).length;
  const consumedHashes = new Map<string, number>();
  for (const [index, step] of aligned.plan.steps.entries()) {
    const hasLedgerRow = ledger.has(stepKey(step.namespace, step.id));
    const pair = pairs[index];
    if (pair === undefined) {
      const recorded =
        (compatHashCounts.get(step.sha256) ?? 0) -
        (consumedHashes.get(step.sha256) ?? 0);
      if (recorded > 0) {
        consumedHashes.set(
          step.sha256,
          (consumedHashes.get(step.sha256) ?? 0) + 1,
        );
        if (!hasLedgerRow) {
          missingLedger.push(stepKey(step.namespace, step.id));
        }
      }
      steps.push({
        index,
        step,
        kind: hasLedgerRow ? "ledger" : "absent",
        matchedHash: null,
      });
      continue;
    }
    const classification = classifyAgainstCompatLog(pair, compat);
    if (classification.kind === "match") {
      consumedHashes.set(
        classification.hash,
        (consumedHashes.get(classification.hash) ?? 0) + 1,
      );
      if (!hasLedgerRow && ledgerHistory) {
        missingLedger.push(stepKey(step.namespace, step.id));
      }
      steps.push({
        index,
        step,
        kind: hasLedgerRow ? "ledger" : "mapped",
        matchedHash: classification.hash,
      });
    } else if (hasLedgerRow || classification.reason === "hash-mismatch") {
      violations.push({ pair, reason: classification.reason });
      steps.push({ index, step, kind: "absent", matchedHash: null });
    } else {
      steps.push({ index, step, kind: "absent", matchedHash: null });
    }
  }

  const lastDone = steps.reduce(
    (last, state) => (state.kind === "absent" ? last : state.index),
    -1,
  );
  const done = (state: MigrationStepState | undefined): boolean =>
    state !== undefined && state.kind !== "absent";
  if (lastDone === -1 && (datedCompatRows > 0 || ledger.size > 0)) {
    throw new MigrationStateUnknown(
      `Database migration history matches no migration step: ${datedCompatRows} compatibility log rows, ${ledger.size} ledger rows`,
      [],
    );
  }

  const deferredIndexes = tagIndexes(aligned, DEFERRED_CLEANUP_TAGS);
  const deferredAbsent = deferredIndexes.filter(
    (index) => steps[index]?.kind === "absent",
  );
  const deferredCleanup =
    !ledgerHistory &&
    lastDone >= 0 &&
    deferredAbsent.length > 0 &&
    sqliteTableExists(sqlite, "projects")
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
    !ledgerHistory &&
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
      !ledgerHistory &&
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

  if (missingLedger.length > 0) {
    throw new MigrationStateUnknown(
      `Database migration history is incomplete. Missing migration ledger rows: ${missingLedger.join("; ")}.`,
      missingLedger,
    );
  }
  const knownCreatedAt = new Set(pairs.map((pair) => pair.createdAt));
  const knownHashes = new Set(
    aligned.plan.steps.slice(pairs.length).map((step) => step.sha256),
  );
  const unrecognised = compat.filter(
    (row) =>
      row.createdAt !== null &&
      !knownCreatedAt.has(row.createdAt) &&
      !knownHashes.has(row.hash),
  );
  if (unrecognised.length > 0) {
    throw new MigrationStateUnknown(
      `Database migration history lists steps this binary does not know (database is newer than this binary): ${unrecognised.length} compatibility log rows.`,
      unrecognised.map((row) => row.hash),
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
    existing: lastDone >= 0 || datedCompatRows > 0 || ledger.size > 0,
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
