import { readFileSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { sourceFolders } from "./plan-apply.js";

/**
 * Upstream steps that landed after the pinned legacy oracle. The oracle's
 * legacy runner cannot apply them, so schema-equality tests replay their SQL on
 * the oracle result to compare like with like.
 */
export const POST_ORACLE_UPSTREAM_TAGS = [
  "0144_thread_parent_notifications",
  "0145_terminal_sessions_status_thread_index",
  "0146_diff_viewed_files",
  "0147_git_and_pr_status_plugin_show_settings",
] as const;

export function applyPostOracleSteps(sqlite: Database.Database): void {
  for (const tag of POST_ORACLE_UPSTREAM_TAGS) {
    const sql = readFileSync(join(sourceFolders.upstreamFolder, `${tag}.sql`), "utf8");
    for (const statement of sql.split("--> statement-breakpoint")) {
      if (statement.trim() !== "") sqlite.exec(statement);
    }
  }
}
