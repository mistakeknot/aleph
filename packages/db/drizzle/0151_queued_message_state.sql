PRAGMA foreign_keys=OFF;--> statement-breakpoint
DROP TRIGGER IF EXISTS `threads_soft_deleted`;--> statement-breakpoint
CREATE TABLE `__new_queued_thread_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`system_notice` text,
	`thread_id` text NOT NULL,
	`content` text NOT NULL,
	`sender_thread_id` text,
	`origin` text,
	`origin_plugin_id` text,
	`origin_id` text,
	`forward_source_row_id` text,
	`requested_by_initiator` text,
	`requested_by_thread_id` text,
	`model` text NOT NULL,
	`reasoning_level` text NOT NULL,
	`permission_mode` text NOT NULL,
	`service_tier` text NOT NULL,
	`group_with_next` integer DEFAULT false NOT NULL,
	`state` text NOT NULL,
	`send_at` integer,
	`waiting_on` text,
	`wait_holder` text,
	`failure_reason` text,
	`failure_count` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer,
	`payload_kind` text DEFAULT 'inline' NOT NULL,
	`retry_of_turn_request_id` text,
	`retry_attempt` integer,
	`retry_reason` text,
	`claimed_at` integer,
	`claim_token` text,
	`edit_held_until` integer,
	`sort_key` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "queued_thread_messages_state_check" CHECK(CASE `state`
        WHEN 'claimed' THEN `claimed_at` IS NOT NULL
        WHEN 'failed_retrying' THEN `claimed_at` IS NULL AND `failure_reason` IS NOT NULL AND `next_attempt_at` IS NOT NULL
        WHEN 'failed_exhausted' THEN `claimed_at` IS NULL AND `failure_reason` IS NOT NULL AND `next_attempt_at` IS NULL
        WHEN 'scheduled' THEN `claimed_at` IS NULL AND `failure_reason` IS NULL AND `send_at` IS NOT NULL
        WHEN 'waiting' THEN `claimed_at` IS NULL AND `failure_reason` IS NULL AND `send_at` IS NULL AND `waiting_on` IS NOT NULL
        WHEN 'queued' THEN `claimed_at` IS NULL AND `failure_reason` IS NULL AND `send_at` IS NULL AND `waiting_on` IS NULL
        ELSE 0
      END),
	CONSTRAINT "queued_thread_messages_claim_check" CHECK((`claimed_at` IS NULL) = (`claim_token` IS NULL)),
	CONSTRAINT "queued_thread_messages_failure_check" CHECK((`failure_reason` IS NULL AND `failure_count` = 0 AND `next_attempt_at` IS NULL)
        OR (`failure_reason` IS NOT NULL AND `failure_count` > 0)),
	CONSTRAINT "queued_thread_messages_schedule_check" CHECK(`send_at` IS NULL OR `waiting_on` IS NOT NULL),
	CONSTRAINT "queued_thread_messages_wait_holder_check" CHECK(`wait_holder` IS (CASE WHEN json_extract(`waiting_on`, '$.kind') = 'plugin' THEN 'plugin:' || json_extract(`waiting_on`, '$.pluginId') END))
);
--> statement-breakpoint
INSERT INTO `__new_queued_thread_messages`("id", "system_notice", "thread_id", "content", "sender_thread_id", "origin", "origin_plugin_id", "origin_id", "forward_source_row_id", "requested_by_initiator", "requested_by_thread_id", "model", "reasoning_level", "permission_mode", "service_tier", "group_with_next", "state", "send_at", "waiting_on", "wait_holder", "failure_reason", "failure_count", "next_attempt_at", "payload_kind", "retry_of_turn_request_id", "retry_attempt", "retry_reason", "claimed_at", "claim_token", "edit_held_until", "sort_key", "created_at", "updated_at")
SELECT
	"id", "system_notice", "thread_id", "content", "sender_thread_id", "origin", "origin_plugin_id", "origin_id", "forward_source_row_id", "requested_by_initiator", "requested_by_thread_id", "model", "reasoning_level", "permission_mode", "service_tier",
	COALESCE((SELECT "group_with_next" FROM bb_migration_queued_message_groups WHERE bb_migration_queued_message_groups."id" = normalized."id"), 0),
	CASE
		WHEN "claimed_at" IS NOT NULL THEN 'claimed'
		WHEN "failure_reason" IS NOT NULL AND "next_attempt_at" IS NOT NULL THEN 'failed_retrying'
		WHEN "failure_reason" IS NOT NULL THEN 'failed_exhausted'
		WHEN "send_at" IS NOT NULL THEN 'scheduled'
		WHEN "waiting_on" IS NOT NULL THEN 'waiting'
		ELSE 'queued'
	END,
	"send_at", "waiting_on",
	CASE WHEN json_extract("waiting_on", '$.kind') = 'plugin' THEN 'plugin:' || json_extract("waiting_on", '$.pluginId') END,
	"failure_reason", "failure_count", "next_attempt_at", "payload_kind", "retry_of_turn_request_id", "retry_attempt", "retry_reason", "claimed_at", "claim_token", "edit_held_until", "sort_key", "created_at", "updated_at"
FROM (
	SELECT
		"id", "system_notice", "thread_id", "content", "sender_thread_id", "origin", "origin_plugin_id", "origin_id", "forward_source_row_id", "requested_by_initiator", "requested_by_thread_id", "model", "reasoning_level", "permission_mode", "service_tier", "send_at", "failure_reason", "payload_kind", "retry_of_turn_request_id", "retry_attempt", "retry_reason", "edit_held_until", "sort_key", "created_at", "updated_at",
		CASE
			WHEN json_valid("waiting_on") THEN "waiting_on"
			WHEN "send_at" IS NOT NULL THEN '{"kind":"time"}'
		END AS "waiting_on",
		CASE
			WHEN "failure_reason" IS NULL THEN 0
			WHEN "failure_count" < 1 THEN 1
			ELSE "failure_count"
		END AS "failure_count",
		CASE WHEN "failure_reason" IS NOT NULL THEN "next_attempt_at" END AS "next_attempt_at",
		CASE WHEN "claimed_at" IS NOT NULL AND "claim_token" IS NOT NULL THEN "claimed_at" END AS "claimed_at",
		CASE WHEN "claimed_at" IS NOT NULL AND "claim_token" IS NOT NULL THEN "claim_token" END AS "claim_token"
	FROM `queued_thread_messages`
) AS normalized;--> statement-breakpoint
DROP TABLE `queued_thread_messages`;--> statement-breakpoint
ALTER TABLE `__new_queued_thread_messages` RENAME TO `queued_thread_messages`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `queued_thread_messages_thread_created_idx` ON `queued_thread_messages` (`thread_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `queued_thread_messages_thread_sort_idx` ON `queued_thread_messages` (`thread_id`,`sort_key`,`id`);--> statement-breakpoint
CREATE INDEX `queued_thread_messages_due_idx` ON `queued_thread_messages` (`state`,`send_at`,`id`);--> statement-breakpoint
CREATE INDEX `queued_thread_messages_retry_idx` ON `queued_thread_messages` (`state`,`next_attempt_at`,`id`);--> statement-breakpoint
CREATE INDEX `queued_thread_messages_wait_holder_idx` ON `queued_thread_messages` (`wait_holder`,`id`) WHERE "queued_thread_messages"."wait_holder" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `qtm_one_slot_per_source` ON `queued_thread_messages` (`forward_source_row_id`) WHERE "queued_thread_messages"."forward_source_row_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX `qtm_one_live_copy` ON `queued_thread_messages` (`origin_id`) WHERE "queued_thread_messages"."forward_source_row_id" IS NULL AND "queued_thread_messages"."origin_id" IS NOT NULL;
--> statement-breakpoint
CREATE TRIGGER `qtm_slot_shape_ins` BEFORE INSERT ON `queued_thread_messages` WHEN NEW.`forward_source_row_id` IS NOT NULL AND NOT (NEW.`claimed_at` IS NOT NULL AND COALESCE(NEW.`claim_token` LIKE 'slot:%' OR NEW.`claim_token` LIKE 'fill:%', 0)) BEGIN SELECT RAISE(ABORT, 'CHECK constraint failed: qtm_slot_shape'); END;
--> statement-breakpoint
CREATE TRIGGER `qtm_slot_shape_upd` BEFORE UPDATE ON `queued_thread_messages` WHEN NEW.`forward_source_row_id` IS NOT NULL AND NOT (NEW.`claimed_at` IS NOT NULL AND COALESCE(NEW.`claim_token` LIKE 'slot:%' OR NEW.`claim_token` LIKE 'fill:%', 0)) BEGIN SELECT RAISE(ABORT, 'CHECK constraint failed: qtm_slot_shape'); END;
--> statement-breakpoint
CREATE TRIGGER `qtm_mint_origin` AFTER INSERT ON `queued_thread_messages` WHEN NEW.`origin_id` IS NULL BEGIN UPDATE `queued_thread_messages` SET `origin_id` = NEW.`id` WHERE `id` = NEW.`id`; END;
--> statement-breakpoint
CREATE TRIGGER `qtm_t2_slot_deleted` AFTER DELETE ON `queued_thread_messages` WHEN OLD.`forward_source_row_id` IS NOT NULL AND OLD.`claim_token` LIKE 'slot:%' BEGIN
UPDATE `transfer_entries` SET `state` = CASE WHEN EXISTS (SELECT 1 FROM `queued_thread_messages` WHERE `id` = OLD.`forward_source_row_id`) THEN 'target_deleted' ELSE 'left_source' END, `updated_at` = CAST(ROUND((julianday('now') - 2440587.5) * 86400000) AS INTEGER) WHERE `kind` = 'slot' AND `state` = 'pending' AND `source_row_id` = OLD.`forward_source_row_id`;
DELETE FROM `queued_thread_messages` WHERE `id` = OLD.`forward_source_row_id`;
END;
--> statement-breakpoint
CREATE TRIGGER `qtm_t3_source_deleted` AFTER DELETE ON `queued_thread_messages` WHEN OLD.`forward_source_row_id` IS NULL BEGIN
DELETE FROM `queued_thread_messages` WHERE `forward_source_row_id` = OLD.`id` AND `claim_token` LIKE 'slot:%';
END;
--> statement-breakpoint
CREATE TRIGGER `qtm_t1_claim_exit` AFTER UPDATE OF `claimed_at`, `claim_token` ON `queued_thread_messages` WHEN OLD.`claimed_at` IS NOT NULL AND NEW.`claimed_at` IS NULL AND NEW.`forward_source_row_id` IS NULL AND EXISTS (SELECT 1 FROM `queued_thread_messages` AS `s` WHERE `s`.`forward_source_row_id` = OLD.`id` AND `s`.`claim_token` LIKE 'slot:%') BEGIN
DELETE FROM `queued_thread_messages` WHERE `forward_source_row_id` = OLD.`id` AND `claim_token` LIKE 'slot:%' AND `thread_id` IN (SELECT `id` FROM `threads` WHERE `deleted_at` IS NOT NULL);
UPDATE `transfer_entries` SET `state` = 'forwarded', `detail` = CASE WHEN EXISTS (SELECT 1 FROM `queued_thread_messages` AS `s` INNER JOIN `threads` AS `t` ON `t`.`id` = `s`.`thread_id` WHERE `s`.`forward_source_row_id` = OLD.`id` AND `s`.`claim_token` LIKE 'slot:%' AND `t`.`archived_at` IS NOT NULL) THEN 'target_archived' ELSE `detail` END, `updated_at` = CAST(ROUND((julianday('now') - 2440587.5) * 86400000) AS INTEGER) WHERE `kind` = 'slot' AND `state` = 'pending' AND `source_row_id` = OLD.`id` AND EXISTS (SELECT 1 FROM `queued_thread_messages` AS `s` WHERE `s`.`forward_source_row_id` = OLD.`id` AND `s`.`claim_token` LIKE 'slot:%');
UPDATE `queued_thread_messages` SET `claim_token` = 'fill:' || OLD.`id` WHERE `forward_source_row_id` = OLD.`id` AND `claim_token` LIKE 'slot:%';
DELETE FROM `queued_thread_messages` WHERE `id` = OLD.`id` AND EXISTS (SELECT 1 FROM `queued_thread_messages` AS `s` WHERE `s`.`forward_source_row_id` = OLD.`id` AND `s`.`claim_token` LIKE 'fill:%');
UPDATE `queued_thread_messages` SET `state` = CASE WHEN (NEW.`waiting_on` IS NULL OR json_extract(NEW.`waiting_on`, '$.kind') IN ('plugin', 'time')) AND NEW.`send_at` IS NOT NULL THEN 'scheduled' WHEN NEW.`waiting_on` IS NULL THEN 'queued' ELSE 'waiting' END, `claimed_at` = NULL, `claim_token` = NULL, `forward_source_row_id` = NULL, `waiting_on` = CASE WHEN NEW.`waiting_on` IS NULL THEN NULL WHEN json_extract(NEW.`waiting_on`, '$.kind') IN ('plugin', 'time') THEN NEW.`waiting_on` WHEN (SELECT `t`.`status` FROM `threads` AS `t` WHERE `t`.`id` = `queued_thread_messages`.`thread_id`) = 'stopping' THEN '{"kind":"stopping"}' ELSE '{"kind":"thread-busy"}' END, `wait_holder` = CASE WHEN json_extract(NEW.`waiting_on`, '$.kind') = 'plugin' THEN NEW.`wait_holder` ELSE NULL END, `send_at` = CASE WHEN NEW.`waiting_on` IS NULL OR json_extract(NEW.`waiting_on`, '$.kind') IN ('plugin', 'time') THEN NEW.`send_at` ELSE NULL END, `updated_at` = CAST(ROUND((julianday('now') - 2440587.5) * 86400000) AS INTEGER) WHERE `forward_source_row_id` = OLD.`id` AND `claim_token` LIKE 'fill:%';
END;
--> statement-breakpoint
CREATE TRIGGER `threads_soft_deleted` AFTER UPDATE OF `deleted_at` ON `threads` WHEN OLD.`deleted_at` IS NULL AND NEW.`deleted_at` IS NOT NULL BEGIN DELETE FROM `queued_thread_messages` WHERE `thread_id` = NEW.`id` AND `forward_source_row_id` IS NOT NULL AND `claim_token` LIKE 'slot:%'; UPDATE `thread_redirects` SET `successor_thread_id` = NULL WHERE `successor_thread_id` = NEW.`id`; DELETE FROM `thread_redirects` WHERE `source_thread_id` = NEW.`id`; END;
