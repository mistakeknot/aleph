import { dirname, join, resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";
import type { DbConnection } from "./connection.js";
import { legacyMigrationChain } from "./legacy-migration-chain.js";
import {
  classifyAgainstCompatLog,
  describeViolations,
  ensureCompatLog,
  ensureLedgerTable,
  expectedCompatPair,
  insertCompatRow,
  insertLedgerRow,
  readCompatLog,
  readMaxCompatCreatedAt,
  type ExpectedCompatPair,
  type MigrationLedgerHow,
} from "./migration-ledger.js";
import { splitMigrationStatements } from "./migration-guard.js";
import type { MigrationPlanFolders } from "./migration-plan.js";
import {
  computeMigrationState,
  isStepPending,
  loadAlignedMigrationPlan,
  readPlanStepSql,
  stageMigrationTempTables,
  type AlignedMigrationPlan,
  type MigrationState,
} from "./migration-runner.js";

export interface ResolveMigrationsFolderForModuleDirArgs {
  moduleDir: string;
}

interface SqliteTableInfoColumn {
  name: string;
  type: string;
  notNull: boolean;
  primaryKey: boolean;
}

interface SqliteForeignKey {
  table: string;
  from: string;
  to: string;
  onUpdate: string;
  onDelete: string;
}

interface SqliteIndex {
  name: string;
  unique: boolean;
}

interface ExpectedColumn {
  name: string;
  type: string;
  notNull: boolean;
  primaryKey: boolean;
}

interface ExpectedForeignKey {
  name: string;
  table: string;
  from: string;
  to: string;
  onUpdate: string;
  onDelete: string;
}

interface ExpectedIndex {
  name: string;
  columns: string[];
  unique: boolean;
}

type ReorderedCleanupMigrationTag =
  | "0033_drop_cleanup_mode"
  | "0034_drop_stop_requested_at"
  | "0035_warm_kingpin";

export interface FutureAppliedMigration {
  createdAt: number;
  hash: string;
}

export interface FutureAppliedMigrationWarningFields {
  migrations: FutureAppliedMigration[];
  now: number;
}

export interface MigrationWarningLogger {
  warn(fields: FutureAppliedMigrationWarningFields, message: string): void;
}

export interface MigrateOptions {
  logger?: MigrationWarningLogger;
}

interface AppliedMigrationRow {
  createdAt: number;
  hash: string;
}

interface ExistingTableRow {
  name: string;
}

interface AppliedMigrationCountRow {
  count: number;
}

interface PendingInteractionProviderRequestDuplicateRow {
  duplicateCount: number;
  providerId: string;
  providerRequestId: string;
  providerThreadId: string;
}

const migrationModuleFilename = fileURLToPath(import.meta.url);
const migrationModuleDirname = dirname(migrationModuleFilename);
const migrationJournalPath = join("meta", "_journal.json");
const pendingInteractionColumns: ExpectedColumn[] = [
  { name: "id", type: "text", notNull: true, primaryKey: true },
  { name: "thread_id", type: "text", notNull: true, primaryKey: false },
  { name: "origin_kind", type: "text", notNull: true, primaryKey: false },
  { name: "turn_id", type: "text", notNull: false, primaryKey: false },
  { name: "provider_id", type: "text", notNull: false, primaryKey: false },
  {
    name: "provider_thread_id",
    type: "text",
    notNull: false,
    primaryKey: false,
  },
  {
    name: "provider_request_id",
    type: "text",
    notNull: false,
    primaryKey: false,
  },
  { name: "plugin_id", type: "text", notNull: false, primaryKey: false },
  { name: "renderer_id", type: "text", notNull: false, primaryKey: false },
  { name: "status", type: "text", notNull: true, primaryKey: false },
  { name: "payload", type: "text", notNull: true, primaryKey: false },
  { name: "resolution", type: "text", notNull: false, primaryKey: false },
  {
    name: "status_reason",
    type: "text",
    notNull: false,
    primaryKey: false,
  },
  { name: "created_at", type: "integer", notNull: true, primaryKey: false },
  { name: "expires_at", type: "integer", notNull: false, primaryKey: false },
  { name: "resolved_at", type: "integer", notNull: false, primaryKey: false },
  { name: "updated_at", type: "integer", notNull: true, primaryKey: false },
];
const pendingInteractionForeignKeys: ExpectedForeignKey[] = [
  {
    name: "pending_interactions.thread_id",
    table: "threads",
    from: "thread_id",
    to: "id",
    onUpdate: "NO ACTION",
    onDelete: "CASCADE",
  },
];
const pendingInteractionIndexes: ExpectedIndex[] = [
  {
    name: "pending_interactions_provider_request_idx",
    columns: ["provider_id", "provider_thread_id", "provider_request_id"],
    unique: true,
  },
  {
    name: "pending_interactions_thread_created_idx",
    columns: ["thread_id", "created_at"],
    unique: false,
  },
  {
    name: "pending_interactions_thread_status_created_idx",
    columns: ["thread_id", "status", "created_at"],
    unique: false,
  },
  {
    name: "pending_interactions_status_created_idx",
    columns: ["status", "created_at"],
    unique: false,
  },
  {
    name: "pending_interactions_plugin_status_created_idx",
    columns: ["plugin_id", "status", "created_at"],
    unique: false,
  },
];

function hasMigrationJournal(migrationsFolder: string): boolean {
  return existsSync(resolve(migrationsFolder, migrationJournalPath));
}

export function resolveMigrationsFolderForModuleDir(
  args: ResolveMigrationsFolderForModuleDirArgs,
): string {
  const sourcePackageCandidate = resolve(args.moduleDir, "..", "drizzle");
  const bundledAssetCandidate = resolve(args.moduleDir, "drizzle");
  const candidates = [sourcePackageCandidate, bundledAssetCandidate];

  for (const candidate of candidates) {
    if (hasMigrationJournal(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    `Missing database migrations. Expected ${migrationJournalPath} under one of: ${candidates.join(", ")}`,
  );
}

const alephManifestPath = "manifest.json";

export function resolveAlephMigrationsFolderForModuleDir(
  args: ResolveMigrationsFolderForModuleDirArgs,
): string {
  const candidates = [
    resolve(args.moduleDir, "..", "drizzle-aleph"),
    resolve(args.moduleDir, "drizzle-aleph"),
  ];

  for (const candidate of candidates) {
    if (existsSync(resolve(candidate, alephManifestPath))) {
      return candidate;
    }
  }

  throw new Error(
    `Missing Aleph database migrations. Expected ${alephManifestPath} under one of: ${candidates.join(", ")}`,
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseTableInfoColumn(value: unknown): SqliteTableInfoColumn {
  if (!isObject(value)) {
    throw new Error("Unexpected PRAGMA table_info row shape");
  }

  const name = value.name;
  const type = value.type;
  const notNull = value.notnull;
  const primaryKey = value.pk;
  if (
    typeof name !== "string" ||
    typeof type !== "string" ||
    typeof notNull !== "number" ||
    typeof primaryKey !== "number"
  ) {
    throw new Error("Unexpected PRAGMA table_info column fields");
  }

  return {
    name,
    type: type.toLowerCase(),
    notNull: notNull !== 0,
    primaryKey: primaryKey !== 0,
  };
}

function parseForeignKey(value: unknown): SqliteForeignKey {
  if (!isObject(value)) {
    throw new Error("Unexpected PRAGMA foreign_key_list row shape");
  }

  const table = value.table;
  const from = value.from;
  const to = value.to;
  const onUpdate = value.on_update;
  const onDelete = value.on_delete;
  if (
    typeof table !== "string" ||
    typeof from !== "string" ||
    typeof to !== "string" ||
    typeof onUpdate !== "string" ||
    typeof onDelete !== "string"
  ) {
    throw new Error("Unexpected PRAGMA foreign_key_list fields");
  }

  return {
    table,
    from,
    to,
    onUpdate,
    onDelete,
  };
}

function parseIndex(value: unknown): SqliteIndex {
  if (!isObject(value)) {
    throw new Error("Unexpected PRAGMA index_list row shape");
  }

  const name = value.name;
  const unique = value.unique;
  if (typeof name !== "string" || typeof unique !== "number") {
    throw new Error("Unexpected PRAGMA index_list fields");
  }

  return {
    name,
    unique: unique !== 0,
  };
}

function parseIndexColumnName(value: unknown): string {
  if (!isObject(value) || typeof value.name !== "string") {
    throw new Error("Unexpected PRAGMA index_info row shape");
  }

  return value.name;
}

function getTableInfo(
  db: DbConnection,
  tableName: string,
): SqliteTableInfoColumn[] {
  const rows = db.$client.pragma(`table_info(${tableName})`);
  if (!Array.isArray(rows)) {
    throw new Error(`Unexpected PRAGMA table_info(${tableName}) result`);
  }

  return rows.map(parseTableInfoColumn);
}

function tableExists(db: DbConnection, tableName: string): boolean {
  return (
    db.$client
      .prepare<[string], ExistingTableRow>(
        `
          SELECT name
          FROM sqlite_master
          WHERE type = 'table'
            AND name = ?
        `,
      )
      .get(tableName) !== undefined
  );
}

function columnExists(
  db: DbConnection,
  tableName: string,
  columnName: string,
): boolean {
  return getTableInfo(db, tableName).some(
    (column) => column.name === columnName,
  );
}

function getForeignKeys(
  db: DbConnection,
  tableName: string,
): SqliteForeignKey[] {
  const rows = db.$client.pragma(`foreign_key_list(${tableName})`);
  if (!Array.isArray(rows)) {
    throw new Error(`Unexpected PRAGMA foreign_key_list(${tableName}) result`);
  }

  return rows.map(parseForeignKey);
}

function getIndexes(db: DbConnection, tableName: string): SqliteIndex[] {
  const rows = db.$client.pragma(`index_list(${tableName})`);
  if (!Array.isArray(rows)) {
    throw new Error(`Unexpected PRAGMA index_list(${tableName}) result`);
  }

  return rows.map(parseIndex);
}

function getIndexColumnNames(db: DbConnection, indexName: string): string[] {
  const rows = db.$client.pragma(`index_info(${indexName})`);
  if (!Array.isArray(rows)) {
    throw new Error(`Unexpected PRAGMA index_info(${indexName}) result`);
  }

  return rows.map(parseIndexColumnName);
}

function indexExists(
  db: DbConnection,
  tableName: string,
  indexName: string,
): boolean {
  return getIndexes(db, tableName).some((index) => index.name === indexName);
}

export function countAppliedMigrations(db: DbConnection): number {
  if (!tableExists(db, "__drizzle_migrations")) {
    return 0;
  }

  const row = db.$client
    .prepare<[], AppliedMigrationCountRow>(
      `
        SELECT COUNT(*) AS count
        FROM __drizzle_migrations
      `,
    )
    .get();

  return row?.count ?? 0;
}

function formatExpectedColumn(column: ExpectedColumn): string {
  return `${column.name} ${column.type} notNull=${column.notNull} primaryKey=${column.primaryKey}`;
}

function formatActualColumn(column: SqliteTableInfoColumn): string {
  return `${column.name} ${column.type} notNull=${column.notNull} primaryKey=${column.primaryKey}`;
}

function validatePendingInteractionsSchema(db: DbConnection): void {
  const columns = getTableInfo(db, "pending_interactions");
  const actualColumnNames = columns.map((column) => column.name);
  const expectedColumnNames = pendingInteractionColumns.map(
    (column) => column.name,
  );
  const missingColumns = expectedColumnNames.filter(
    (column) => !actualColumnNames.includes(column),
  );
  const extraColumns = actualColumnNames.filter(
    (column) => !expectedColumnNames.includes(column),
  );
  const columnMismatches: string[] = [];
  for (const expectedColumn of pendingInteractionColumns) {
    const actualColumn = columns.find(
      (column) => column.name === expectedColumn.name,
    );
    if (actualColumn === undefined) {
      continue;
    }

    if (
      actualColumn.type !== expectedColumn.type ||
      actualColumn.notNull !== expectedColumn.notNull ||
      actualColumn.primaryKey !== expectedColumn.primaryKey
    ) {
      columnMismatches.push(
        `${expectedColumn.name}: expected ${formatExpectedColumn(expectedColumn)}, got ${formatActualColumn(actualColumn)}`,
      );
    }
  }

  const foreignKeys = getForeignKeys(db, "pending_interactions");
  const missingForeignKeys = pendingInteractionForeignKeys.filter(
    (expectedForeignKey) =>
      !foreignKeys.some(
        (foreignKey) =>
          foreignKey.table === expectedForeignKey.table &&
          foreignKey.from === expectedForeignKey.from &&
          foreignKey.to === expectedForeignKey.to &&
          foreignKey.onUpdate === expectedForeignKey.onUpdate &&
          foreignKey.onDelete === expectedForeignKey.onDelete,
      ),
  );

  const indexes = getIndexes(db, "pending_interactions");
  const missingOrMismatchedIndexes: string[] = [];
  for (const expectedIndex of pendingInteractionIndexes) {
    const actualIndex = indexes.find(
      (index) => index.name === expectedIndex.name,
    );
    if (actualIndex === undefined) {
      missingOrMismatchedIndexes.push(`${expectedIndex.name}: missing`);
      continue;
    }

    const actualColumns = getIndexColumnNames(db, expectedIndex.name);
    if (
      actualIndex.unique !== expectedIndex.unique ||
      actualColumns.length !== expectedIndex.columns.length ||
      actualColumns.some(
        (column, index) => column !== expectedIndex.columns[index],
      )
    ) {
      missingOrMismatchedIndexes.push(
        `${expectedIndex.name}: expected unique=${expectedIndex.unique} columns=${expectedIndex.columns.join(",")}, got unique=${actualIndex.unique} columns=${actualColumns.join(",")}`,
      );
    }
  }

  if (
    missingColumns.length > 0 ||
    extraColumns.length > 0 ||
    columnMismatches.length > 0 ||
    missingForeignKeys.length > 0 ||
    missingOrMismatchedIndexes.length > 0
  ) {
    throw new Error(
      [
        "Database schema drift detected for pending_interactions after migration.",
        missingColumns.length > 0
          ? `Missing columns: ${missingColumns.join(", ")}.`
          : null,
        extraColumns.length > 0
          ? `Unexpected columns: ${extraColumns.join(", ")}.`
          : null,
        columnMismatches.length > 0
          ? `Column mismatches: ${columnMismatches.join("; ")}.`
          : null,
        missingForeignKeys.length > 0
          ? `Missing foreign keys: ${missingForeignKeys.map((foreignKey) => foreignKey.name).join(", ")}.`
          : null,
        missingOrMismatchedIndexes.length > 0
          ? `Missing or mismatched indexes: ${missingOrMismatchedIndexes.join("; ")}.`
          : null,
        "This usually means the local DB was created by an incompatible prelaunch migration history. Restart BB so migrations can run; if this persists in development, back up the DB and run pnpm reset:dev.",
      ]
        .filter((line): line is string => line !== null)
        .join(" "),
    );
  }
}

function assertNoDuplicatePendingInteractionProviderRequests(
  db: DbConnection,
): void {
  const columnNames = getTableInfo(db, "pending_interactions").map(
    (column) => column.name,
  );
  if (
    !columnNames.includes("provider_id") ||
    !columnNames.includes("provider_thread_id") ||
    !columnNames.includes("provider_request_id")
  ) {
    return;
  }

  const duplicates = db.$client
    .prepare<[], PendingInteractionProviderRequestDuplicateRow>(
      `
        SELECT
          provider_id AS providerId,
          provider_thread_id AS providerThreadId,
          provider_request_id AS providerRequestId,
          COUNT(*) AS duplicateCount
        FROM pending_interactions
        WHERE provider_id IS NOT NULL
          AND provider_thread_id IS NOT NULL
          AND provider_request_id IS NOT NULL
        GROUP BY provider_id, provider_thread_id, provider_request_id
        HAVING COUNT(*) > 1
        ORDER BY duplicateCount DESC, provider_id, provider_thread_id, provider_request_id
        LIMIT 10
      `,
    )
    .all();
  if (duplicates.length === 0) {
    return;
  }

  throw new Error(
    [
      "Cannot migrate pending_interactions provider request uniqueness because duplicate provider requests already exist.",
      "Provider request identity is now provider_id/provider_thread_id/provider_request_id independent of session_id.",
      `Resolve duplicate pending_interactions rows before restarting. Duplicates: ${duplicates
        .map(
          (row) =>
            `${row.providerId}/${row.providerThreadId}/${row.providerRequestId} count=${row.duplicateCount}`,
        )
        .join("; ")}.`,
    ].join(" "),
  );
}

function applyDeferredOperationStateBackfill(db: DbConnection): void {
  if (!columnExists(db, "projects", "deleted_at")) {
    db.$client.prepare("ALTER TABLE projects ADD deleted_at integer").run();
  }

  if (tableExists(db, "project_operations")) {
    db.$client
      .prepare(
        `
          UPDATE projects
          SET deleted_at = (
            SELECT project_operations.requested_at
            FROM project_operations
            WHERE project_operations.project_id = projects.id
              AND project_operations.kind = 'delete'
              AND project_operations.state IN ('requested', 'queued')
            ORDER BY project_operations.requested_at ASC
            LIMIT 1
          )
          WHERE EXISTS (
            SELECT 1
            FROM project_operations
            WHERE project_operations.project_id = projects.id
              AND project_operations.kind = 'delete'
              AND project_operations.state IN ('requested', 'queued')
          )
        `,
      )
      .run();
  }

  if (tableExists(db, "thread_operations")) {
    db.$client
      .prepare(
        `
          UPDATE threads
          SET status = 'error'
          WHERE EXISTS (
            SELECT 1
            FROM thread_operations
            WHERE thread_operations.thread_id = threads.id
              AND thread_operations.kind = 'provision'
              AND thread_operations.state IN ('requested', 'queued')
          )
            AND threads.status IN ('created', 'provisioning')
        `,
      )
      .run();

    db.$client
      .prepare(
        `
          UPDATE threads
          SET stop_requested_at = COALESCE(stop_requested_at, (
            SELECT thread_operations.requested_at
            FROM thread_operations
            WHERE thread_operations.thread_id = threads.id
              AND thread_operations.kind = 'stop'
              AND thread_operations.state IN ('requested', 'queued')
            ORDER BY thread_operations.requested_at DESC
            LIMIT 1
          ))
          WHERE stop_requested_at IS NOT NULL
            OR EXISTS (
              SELECT 1
              FROM thread_operations
              WHERE thread_operations.thread_id = threads.id
                AND thread_operations.kind = 'stop'
                AND thread_operations.state IN ('requested', 'queued')
            )
        `,
      )
      .run();

    db.$client
      .prepare(
        `
          INSERT OR IGNORE INTO events (
            id,
            thread_id,
            environment_id,
            scope_kind,
            turn_id,
            provider_thread_id,
            sequence,
            type,
            item_id,
            item_kind,
            data,
            created_at
          )
          SELECT
            'evt_' || thread_operations.id,
            thread_operations.thread_id,
            threads.environment_id,
            'thread',
            NULL,
            NULL,
            COALESCE((
              SELECT MAX(existing_events.sequence)
              FROM events AS existing_events
              WHERE existing_events.thread_id = thread_operations.thread_id
            ), 0) + 1,
            'system/thread/interrupted',
            NULL,
            NULL,
            json_object(
              'reason',
              CASE json_extract(thread_operations.payload, '$.interruptionReason')
                WHEN 'manual-stop' THEN 'manual-stop'
                WHEN 'host-daemon-restarted' THEN 'host-daemon-restarted'
                WHEN 'provider-turn-idle' THEN 'provider-turn-idle'
                ELSE 'manual-stop'
              END
            ),
            thread_operations.requested_at
          FROM thread_operations
          INNER JOIN threads ON threads.id = thread_operations.thread_id
          WHERE thread_operations.kind = 'stop'
            AND thread_operations.state IN ('requested', 'queued')
        `,
      )
      .run();
  }

  if (tableExists(db, "environment_operations")) {
    db.$client
      .prepare(
        `
          UPDATE environments
          SET status = 'error'
          WHERE environments.status = 'provisioning'
            AND EXISTS (
              SELECT 1
              FROM environment_operations
              WHERE environment_operations.environment_id = environments.id
                AND environment_operations.kind IN ('provision', 'reprovision')
                AND environment_operations.state IN ('requested', 'queued')
            )
        `,
      )
      .run();
  }

  if (!indexExists(db, "projects", "projects_deleted_idx")) {
    db.$client
      .prepare("CREATE INDEX projects_deleted_idx ON projects (deleted_at)")
      .run();
  }
}

function applyReorderedCleanupMigration(
  db: DbConnection,
  tag: ReorderedCleanupMigrationTag,
): void {
  switch (tag) {
    case "0033_drop_cleanup_mode": {
      if (
        tableExists(db, "environments") &&
        columnExists(db, "environments", "cleanup_mode")
      ) {
        db.$client
          .prepare("ALTER TABLE `environments` DROP COLUMN `cleanup_mode`")
          .run();
      }
      return;
    }
    case "0034_drop_stop_requested_at": {
      if (
        tableExists(db, "threads") &&
        columnExists(db, "threads", "stop_requested_at")
      ) {
        db.$client
          .prepare("ALTER TABLE `threads` DROP COLUMN `stop_requested_at`")
          .run();
      }
      return;
    }
    case "0035_warm_kingpin": {
      if (tableExists(db, "environments")) {
        if (columnExists(db, "environments", "cleanup_requested_at")) {
          db.$client
            .prepare(
              `
                UPDATE environments
                SET status = 'retiring'
                WHERE status = 'ready'
                  AND cleanup_requested_at IS NOT NULL
              `,
            )
            .run();
        }
        if (
          indexExists(db, "environments", "environments_cleanup_requested_idx")
        ) {
          db.$client
            .prepare("DROP INDEX `environments_cleanup_requested_idx`")
            .run();
        }
        if (columnExists(db, "environments", "cleanup_requested_at")) {
          db.$client
            .prepare(
              "ALTER TABLE `environments` DROP COLUMN `cleanup_requested_at`",
            )
            .run();
        }
      }
      if (tableExists(db, "threads")) {
        db.$client
          .prepare(
            `
              UPDATE threads
              SET status = 'starting'
              WHERE status IN ('created', 'provisioning')
            `,
          )
          .run();
      }
      return;
    }
  }
}

const STAGED_CONNECT_MACHINE_ID_COLUMN = "_bb_connect_machine_id_pending";
const STAGED_THREAD_STORAGE_DELETED_AT_COLUMN =
  "_bb_thread_storage_deleted_at_pending";

function restoreStagedConnectMachineIdColumn(db: DbConnection): void {
  if (!columnExists(db, "hosts", STAGED_CONNECT_MACHINE_ID_COLUMN)) {
    return;
  }
  if (!columnExists(db, "hosts", "connect_machine_id")) {
    db.$client.exec(
      `ALTER TABLE hosts RENAME COLUMN ${STAGED_CONNECT_MACHINE_ID_COLUMN} TO connect_machine_id`,
    );
    return;
  }
  db.$client.exec(
    `UPDATE hosts SET connect_machine_id = ${STAGED_CONNECT_MACHINE_ID_COLUMN};
     ALTER TABLE hosts DROP COLUMN ${STAGED_CONNECT_MACHINE_ID_COLUMN};`,
  );
}

function restoreStagedThreadStorageDeletedAtColumn(db: DbConnection): void {
  if (!columnExists(db, "threads", STAGED_THREAD_STORAGE_DELETED_AT_COLUMN)) {
    return;
  }
  if (!columnExists(db, "threads", "storage_deleted_at")) {
    db.$client.exec(
      `ALTER TABLE threads RENAME COLUMN ${STAGED_THREAD_STORAGE_DELETED_AT_COLUMN} TO storage_deleted_at`,
    );
    return;
  }
  db.$client.exec(
    `UPDATE threads SET storage_deleted_at = ${STAGED_THREAD_STORAGE_DELETED_AT_COLUMN};
     ALTER TABLE threads DROP COLUMN ${STAGED_THREAD_STORAGE_DELETED_AT_COLUMN};`,
  );
}

function seedKeepAwakePluginConfiguration(db: DbConnection): void {
  if (
    !tableExists(db, "app_settings") ||
    !columnExists(db, "app_settings", "caffeinate") ||
    !tableExists(db, "plugin_kv")
  ) {
    return;
  }
  db.$client.exec(`
    INSERT INTO plugin_kv (plugin_id, key, value, updated_at)
    SELECT
      'keep-awake',
      'configuration',
      CASE caffeinate
        WHEN 1 THEN '{"enabled":true,"selection":{"mode":"all"}}'
        ELSE '{"enabled":false,"selection":{"mode":"all"}}'
      END,
      updated_at
    FROM app_settings
    WHERE id = 'current'
    ON CONFLICT (plugin_id, key) DO NOTHING
  `);
}

function keepAwakeSeedPending(db: DbConnection): boolean {
  if (
    !tableExists(db, "app_settings") ||
    !columnExists(db, "app_settings", "caffeinate") ||
    !tableExists(db, "plugin_kv")
  ) {
    return false;
  }
  return (
    db.$client
      .prepare(
        `SELECT 1 FROM app_settings
         WHERE id = 'current'
           AND NOT EXISTS (
             SELECT 1 FROM plugin_kv
             WHERE plugin_id = 'keep-awake' AND key = 'configuration'
           )`,
      )
      .get() !== undefined
  );
}

function warnAboutFutureAppliedMigrations(
  db: DbConnection,
  options: MigrateOptions,
): void {
  if (!options.logger) {
    return;
  }

  const now = Date.now();
  const migrations = db.$client
    .prepare<[number], AppliedMigrationRow>(
      `
        SELECT hash, created_at AS createdAt
        FROM __drizzle_migrations
        WHERE created_at IS NOT NULL
          AND created_at > ?
        ORDER BY created_at
      `,
    )
    .all(now);

  if (migrations.length === 0) {
    return;
  }

  options.logger.warn(
    {
      migrations,
      now,
    },
    "Applied database migrations have future timestamps",
  );
}

function resolveMigrationFolders(): MigrationPlanFolders {
  return {
    upstreamFolder: resolveMigrationsFolderForModuleDir({
      moduleDir: migrationModuleDirname,
    }),
    alephFolder: resolveAlephMigrationsFolderForModuleDir({
      moduleDir: migrationModuleDirname,
    }),
  };
}

function readHostId(sqlite: Database.Database): string | null {
  if (sqlite.name === ":memory:") return null;
  const identityPath = join(dirname(sqlite.name), "host-id");
  if (!existsSync(identityPath)) return null;
  const hostId = readFileSync(identityPath, "utf8").trim();
  return hostId.length > 0 ? hostId : null;
}

function isReorderedCleanupTag(
  tag: string,
): tag is ReorderedCleanupMigrationTag {
  return (
    tag === "0033_drop_cleanup_mode" ||
    tag === "0034_drop_stop_requested_at" ||
    tag === "0035_warm_kingpin"
  );
}

function runStepSql(
  sqlite: Database.Database,
  aligned: AlignedMigrationPlan,
  index: number,
): void {
  const step = aligned.plan.steps[index];
  if (step === undefined) {
    throw new Error(`Migration plan has no step at position ${index}`);
  }
  for (const statement of splitMigrationStatements(
    readPlanStepSql(aligned.folders, step),
  )) {
    sqlite.exec(statement);
  }
}

function stageConnectMachineIdColumn(
  db: DbConnection,
  state: MigrationState,
): boolean {
  if (
    !isStepPending(state, "upstream", "0065_empty_leper_queen") ||
    !tableExists(db, "hosts") ||
    !columnExists(db, "hosts", "connect_machine_id")
  ) {
    return false;
  }
  db.$client.exec(
    `ALTER TABLE hosts RENAME COLUMN connect_machine_id TO ${STAGED_CONNECT_MACHINE_ID_COLUMN}`,
  );
  return true;
}

function stageThreadStorageDeletedAtColumn(
  db: DbConnection,
  state: MigrationState,
): boolean {
  if (
    !isStepPending(state, "upstream", "0120_perfect_clint_barton") ||
    !tableExists(db, "threads") ||
    !columnExists(db, "threads", "storage_deleted_at")
  ) {
    return false;
  }
  db.$client.exec(
    `ALTER TABLE threads RENAME COLUMN storage_deleted_at TO ${STAGED_THREAD_STORAGE_DELETED_AT_COLUMN}`,
  );
  return true;
}

function stageQueuedMessageGroups(
  db: DbConnection,
  state: MigrationState,
): void {
  if (
    !isStepPending(state, "aleph", "A0009") ||
    !tableExists(db, "queued_thread_messages") ||
    !columnExists(db, "queued_thread_messages", "group_with_next")
  ) {
    return;
  }
  db.$client.exec(
    "INSERT INTO bb_migration_queued_message_groups (id, group_with_next) SELECT id, group_with_next FROM queued_thread_messages",
  );
}

function applyMigrationState(
  db: DbConnection,
  aligned: AlignedMigrationPlan,
  state: MigrationState,
): void {
  const sqlite = db.$client;
  stageMigrationTempTables(sqlite, {
    existing: state.existing,
    hostId: readHostId(sqlite),
  });
  ensureLedgerTable(sqlite);
  ensureCompatLog(sqlite);
  const now = Date.now();

  const recordStep = (index: number, how: MigrationLedgerHow): void => {
    const step = aligned.plan.steps[index];
    if (step === undefined) {
      throw new Error(`Migration plan has no step at position ${index}`);
    }
    insertLedgerRow(
      sqlite,
      {
        namespace: step.namespace,
        tag: step.id,
        sha256: state.steps[index]?.matchedHash ?? step.sha256,
        how,
      },
      now,
    );
    if (how !== "mapped") {
      const legacy = legacyMigrationChain[index];
      insertCompatRow(
        sqlite,
        legacy !== undefined
          ? { createdAt: legacy.when, hash: legacy.sha256 }
          : {
              createdAt: Math.max(
                step.when,
                (readMaxCompatCreatedAt(sqlite) ?? 0) + 1,
              ),
              hash: step.sha256,
            },
      );
    }
    for (const replaced of aligned.plan.superseded) {
      if (replaced.supersededBy !== step.id) continue;
      insertLedgerRow(
        sqlite,
        {
          namespace: replaced.namespace,
          tag: replaced.id,
          sha256: replaced.sha256,
          how: `superseded-by:${step.id}`,
        },
        now,
      );
    }
  };

  for (const index of state.mapped) recordStep(index, "mapped");

  stageQueuedMessageGroups(db, state);
  const stagedConnectMachineId = stageConnectMachineIdColumn(db, state);
  const stagedThreadStorageDeletedAt = stageThreadStorageDeletedAtColumn(
    db,
    state,
  );

  for (const index of state.deferredCleanup) {
    if (aligned.plan.steps[index]?.id === "0015_good_lila_cheney") {
      applyDeferredOperationStateBackfill(db);
      recordStep(index, "function");
    } else {
      recordStep(index, "mark-only");
    }
  }
  for (const index of state.skipLargeValues) {
    if (aligned.plan.steps[index]?.id === "0030_popout_chat_experiments") {
      runStepSql(sqlite, aligned, index);
      recordStep(index, "applied");
    } else {
      recordStep(index, "mark-only");
    }
  }
  for (const index of state.pending) {
    runStepSql(sqlite, aligned, index);
    recordStep(index, "applied");
  }

  if (stagedConnectMachineId) restoreStagedConnectMachineIdColumn(db);
  if (stagedThreadStorageDeletedAt) {
    restoreStagedThreadStorageDeletedAtColumn(db);
  }

  for (const index of state.reorderedCleanup) {
    const id = aligned.plan.steps[index]?.id;
    if (id === undefined || !isReorderedCleanupTag(id)) {
      throw new Error(`Migration step at position ${index} is not a cleanup`);
    }
    applyReorderedCleanupMigration(db, id);
    recordStep(index, "function");
  }
  seedKeepAwakePluginConfiguration(db);
}

function readMigrationState(
  sqlite: Database.Database,
  aligned: AlignedMigrationPlan,
): MigrationState {
  sqlite.exec("BEGIN");
  try {
    return computeMigrationState(sqlite, aligned);
  } finally {
    if (sqlite.inTransaction) sqlite.exec("ROLLBACK");
  }
}

function validateAppliedMigrationHistory(
  db: DbConnection,
  aligned: AlignedMigrationPlan,
): void {
  const compat = readCompatLog(db.$client);
  const violations: Array<{
    pair: ExpectedCompatPair;
    reason: "hash-mismatch" | "missing-created-at";
  }> = [];
  for (const legacy of aligned.legacy) {
    const pair = expectedCompatPair(legacy);
    const classification = classifyAgainstCompatLog(pair, compat);
    if (classification.kind === "violation") {
      violations.push({ pair, reason: classification.reason });
    }
  }
  if (violations.length > 0) {
    throw new Error(
      describeViolations(
        violations,
        "Database migration history is incomplete after migration.",
      ),
    );
  }
}

export function migrate(db: DbConnection, options: MigrateOptions = {}): void {
  migrateWithFolders(db, resolveMigrationFolders(), options);
}

export function migrateWithFolders(
  db: DbConnection,
  folders: MigrationPlanFolders,
  options: MigrateOptions = {},
): void {
  const sqlite = db.$client;
  if (sqlite.pragma("temp_store", { simple: true }) === 2) {
    throw new Error(
      "Database migrations need a file-backed temp store; temp_store is set to MEMORY",
    );
  }
  const aligned = loadAlignedMigrationPlan(folders);

  sqlite.pragma("foreign_keys = OFF");
  try {
    assertNoDuplicatePendingInteractionProviderRequests(db);
    if (
      readMigrationState(sqlite, aligned).needsWrite ||
      keepAwakeSeedPending(db)
    ) {
      sqlite.exec("BEGIN IMMEDIATE");
      try {
        const state = computeMigrationState(sqlite, aligned);
        if (state.needsWrite || keepAwakeSeedPending(db)) {
          applyMigrationState(db, aligned, state);
        }
        sqlite.exec("COMMIT");
      } catch (error) {
        if (sqlite.inTransaction) sqlite.exec("ROLLBACK");
        throw error;
      }
    }
  } finally {
    sqlite.pragma("foreign_keys = ON");
  }

  warnAboutFutureAppliedMigrations(db, options);
  validateAppliedMigrationHistory(db, aligned);
  validatePendingInteractionsSchema(db);
}
