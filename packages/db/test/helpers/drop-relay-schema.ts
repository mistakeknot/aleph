import type { DbConnection } from "../../src/connection.js";

interface TableInfoRow {
  name: string;
}

export function dropRelaySchema(db: DbConnection): void {
  db.$client.exec(`
    DROP TABLE IF EXISTS relay_targets;
    DROP TABLE IF EXISTS relay_messages;
    DROP TABLE IF EXISTS relay_usage;
    DROP TABLE IF EXISTS attachment_pending_scan_cursors;
    DROP TABLE IF EXISTS gate_assertion_uses;
    DROP TABLE IF EXISTS connect_binding;
    DROP INDEX IF EXISTS project_attachments_relay_attempt_idx;
  `);
  for (const [table, column] of [
    ["queued_thread_messages", "relay_provenance"],
    ["project_attachments", "relay_message_id"],
    ["project_attachments", "relay_attempt_token"],
  ] as const) {
    const present = db.$client
      .prepare<[], TableInfoRow>(`PRAGMA table_info(${table})`)
      .all()
      .some((row) => row.name === column);
    if (present) db.$client.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
  }
}
