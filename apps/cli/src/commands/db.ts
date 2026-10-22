import { resolve } from "node:path";
import { Command } from "commander";
import { action, CliExitError } from "../action.js";
import { outputJson } from "./helpers.js";

interface RestoreMigrationBackupOptions {
  allowSourceMismatch?: boolean;
  check?: boolean;
  database?: string;
  json?: boolean;
}

export function registerDbCommands(program: Command): void {
  const db = program
    .command("db")
    .description("Maintain the local bb database file");

  db.command("restore-migration-backup <path>")
    .description(
      "Verify a migration backup and, unless --check is given, restore the database from it. Stop every process using the database first; the previous contents are kept in a .broken-<timestamp> copy beside it. Install the older bb binary before restarting.",
    )
    .option(
      "--database <path>",
      "Database file to restore over (default: the backup path without its .pre-ns-… suffix)",
    )
    .option(
      "--allow-source-mismatch",
      "Restore even when the backup was taken from a database with a different file name than the target",
    )
    .option("--check", "Verify the backup and report; change nothing")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (path: string, opts: RestoreMigrationBackupOptions) => {
        const { MigrationRestoreError, restoreMigrationBackup } =
          await import("@bb/db/migration-restore");
        const result = (() => {
          try {
            return restoreMigrationBackup(resolve(path), {
              checkOnly: opts.check === true,
              allowSourceMismatch: opts.allowSourceMismatch === true,
              ...(opts.database === undefined
                ? {}
                : { databasePath: resolve(opts.database) }),
            });
          } catch (error) {
            if (error instanceof MigrationRestoreError) {
              throw new CliExitError(error.message, 1, {
                code: "migration_restore_failed",
                hint: null,
              });
            }
            throw error;
          }
        })();
        if (outputJson(opts, result)) return;
        if (result.mode === "check") {
          console.log(
            `Backup ${result.backupPath} verified: ${result.tables} tables, ${result.rows} rows. Nothing was changed.`,
          );
        } else {
          console.log(
            `Restored ${result.databasePath} from ${result.backupPath}: ${result.tables} tables, ${result.rows} rows in ${result.elapsedMs} ms.`,
          );
          console.log(`Previous contents kept in ${result.brokenCopyPath}`);
        }
        console.log(
          result.digestVerification === "compared"
            ? "Content digest compared with the sidecar."
            : `Content digest recomputed, not compared (${result.digestVerification === "recomputed-pending" ? "sidecar digest pending" : "sidecar projection differs"}).`,
        );
        console.log(result.nextStep);
      }),
    );
}
