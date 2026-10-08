import type { DbConnection } from "../../src/connection.js";

const TRANSFER_LEDGER_TRIGGERS = [
  "qtm_slot_shape_ins",
  "qtm_slot_shape_upd",
  "qtm_mint_origin",
  "events_append_only",
  "entries_event_ins",
  "entries_event_upd",
  "threads_rewire",
  "threads_soft_deleted",
  "qtm_t1_claim_exit",
  "qtm_t2_slot_deleted",
  "qtm_t3_source_deleted",
];

const TRANSFER_LEDGER_TABLES = [
  "thread_redirects",
  "transfer_events",
  "transfer_entries",
  "transfer_operations",
];

const TRANSFER_LEDGER_INDEXES = [
  "qtm_one_slot_per_source",
  "qtm_one_live_copy",
];

const TRANSFER_LEDGER_COLUMNS = ["origin_id", "forward_source_row_id"];

export function dropTransferLedgerSchema(db: DbConnection): void {
  for (const trigger of TRANSFER_LEDGER_TRIGGERS) {
    db.$client.exec(`DROP TRIGGER IF EXISTS ${trigger}`);
  }
  for (const table of TRANSFER_LEDGER_TABLES) {
    db.$client.exec(`DROP TABLE IF EXISTS ${table}`);
  }
  for (const index of TRANSFER_LEDGER_INDEXES) {
    db.$client.exec(`DROP INDEX IF EXISTS ${index}`);
  }
  const columns = db.$client
    .prepare<[], { name: string }>("PRAGMA table_info(queued_thread_messages)")
    .all();
  for (const name of TRANSFER_LEDGER_COLUMNS) {
    if (!columns.some((column) => column.name === name)) continue;
    db.$client.exec(`ALTER TABLE queued_thread_messages DROP COLUMN ${name}`);
  }
}
