import { PIN_BODY_MAX } from "./contract.js";

export const PIN_MIGRATIONS = [
  `CREATE TABLE pins (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    page_id TEXT NOT NULL,
    source_path TEXT NOT NULL,
    claim_label TEXT,
    claim_context TEXT,
    claim_ordinal INTEGER,
    claim_group_size INTEGER,
    body TEXT NOT NULL CHECK (length(trim(body)) BETWEEN 1 AND ${PIN_BODY_MAX}),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    resolved_at TEXT,
    CHECK (
      (claim_label IS NULL AND claim_context IS NULL AND claim_ordinal IS NULL AND claim_group_size IS NULL)
      OR (claim_label IS NOT NULL AND claim_context IS NOT NULL AND claim_ordinal IS NOT NULL AND claim_group_size IS NOT NULL
        AND claim_ordinal >= 0 AND claim_group_size >= 1 AND claim_ordinal < claim_group_size)
    )
  );
  CREATE INDEX pins_by_page ON pins (project_id, page_id);
  CREATE TABLE pin_threads (
    pin_id TEXT NOT NULL REFERENCES pins (id) ON DELETE CASCADE,
    thread_id TEXT NOT NULL,
    linked_at TEXT NOT NULL,
    PRIMARY KEY (pin_id, thread_id)
  );`,
  `CREATE TABLE pin_tasks (
    pin_id TEXT NOT NULL REFERENCES pins (id) ON DELETE CASCADE,
    task_id TEXT NOT NULL,
    task_key TEXT NOT NULL,
    task_project_id TEXT NOT NULL,
    linked_at TEXT NOT NULL,
    PRIMARY KEY (pin_id, task_id)
  );`,
];
