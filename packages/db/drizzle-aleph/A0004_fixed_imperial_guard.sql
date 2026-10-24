CREATE TABLE `thread_redirects` (
	`source_thread_id` text PRIMARY KEY NOT NULL,
	`successor_thread_id` text,
	`op_id` text NOT NULL,
	FOREIGN KEY (`source_thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`successor_thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE no action,
	CHECK (`source_thread_id` <> `successor_thread_id`),
	FOREIGN KEY (`op_id`) REFERENCES `transfer_operations`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE TABLE `transfer_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`op_id` text NOT NULL,
	`kind` text NOT NULL CHECK (`kind` IN ('moved','slot','not_forwardable','redirected','returned','residual')),
	`origin_id` text,
	`source_row_id` text,
	`source_sort_key` text,
	`target_row_id` text,
	`detail` text,
	`state` text NOT NULL CHECK (`state` IN ('pending','forwarded','left_source','target_deleted','terminal')),
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`op_id`) REFERENCES `transfer_operations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `transfer_events` (
	`event_id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`op_id` text NOT NULL,
	`entry_id` text NOT NULL,
	`state` text NOT NULL,
	`payload` text NOT NULL,
	`emitted_at` integer,
	FOREIGN KEY (`op_id`) REFERENCES `transfer_operations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `transfer_operations` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`operation_key` text NOT NULL,
	`request_hash` text NOT NULL,
	`kind` text NOT NULL CHECK (`kind` IN ('retire','abort')),
	`source_thread_id` text NOT NULL,
	`target_thread_id` text NOT NULL,
	`state` text NOT NULL CHECK (`state` IN ('active','aborted','done')),
	`result_json` text,
	`acked_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `transfer_operations_project_key_idx` ON `transfer_operations` (`project_id`,`operation_key`);--> statement-breakpoint
ALTER TABLE `queued_thread_messages` ADD `origin_id` text;--> statement-breakpoint
ALTER TABLE `queued_thread_messages` ADD `forward_source_row_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `qtm_one_slot_per_source` ON `queued_thread_messages` (`forward_source_row_id`) WHERE "queued_thread_messages"."forward_source_row_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `qtm_one_live_copy` ON `queued_thread_messages` (`origin_id`) WHERE "queued_thread_messages"."forward_source_row_id" IS NULL AND "queued_thread_messages"."origin_id" IS NOT NULL;--> statement-breakpoint
UPDATE `queued_thread_messages` SET `origin_id` = `id` WHERE `origin_id` IS NULL;--> statement-breakpoint
CREATE TRIGGER `qtm_slot_shape_ins` BEFORE INSERT ON `queued_thread_messages` WHEN NEW.`forward_source_row_id` IS NOT NULL AND NOT (NEW.`claimed_at` IS NOT NULL AND COALESCE(NEW.`claim_token` LIKE 'slot:%' OR NEW.`claim_token` LIKE 'fill:%', 0)) BEGIN SELECT RAISE(ABORT, 'CHECK constraint failed: qtm_slot_shape'); END;--> statement-breakpoint
CREATE TRIGGER `qtm_slot_shape_upd` BEFORE UPDATE ON `queued_thread_messages` WHEN NEW.`forward_source_row_id` IS NOT NULL AND NOT (NEW.`claimed_at` IS NOT NULL AND COALESCE(NEW.`claim_token` LIKE 'slot:%' OR NEW.`claim_token` LIKE 'fill:%', 0)) BEGIN SELECT RAISE(ABORT, 'CHECK constraint failed: qtm_slot_shape'); END;--> statement-breakpoint
CREATE TRIGGER `qtm_mint_origin` AFTER INSERT ON `queued_thread_messages` WHEN NEW.`origin_id` IS NULL BEGIN UPDATE `queued_thread_messages` SET `origin_id` = NEW.`id` WHERE `id` = NEW.`id`; END;--> statement-breakpoint
CREATE TRIGGER `events_append_only` BEFORE UPDATE ON `transfer_events` WHEN NEW.`event_id` IS NOT OLD.`event_id` OR NEW.`op_id` IS NOT OLD.`op_id` OR NEW.`entry_id` IS NOT OLD.`entry_id` OR NEW.`state` IS NOT OLD.`state` OR NEW.`payload` IS NOT OLD.`payload` OR OLD.`emitted_at` IS NOT NULL BEGIN SELECT RAISE(ABORT, 'transfer_events are append-only'); END;--> statement-breakpoint
CREATE TRIGGER `entries_event_ins` AFTER INSERT ON `transfer_entries` BEGIN INSERT INTO `transfer_events` (`op_id`, `entry_id`, `state`, `payload`) VALUES (NEW.`op_id`, NEW.`id`, NEW.`state`, json_object('kind', NEW.`kind`, 'state', NEW.`state`, 'rowId', NEW.`target_row_id`, 'sourceId', NEW.`source_row_id`, 'origin', NEW.`origin_id`)); END;--> statement-breakpoint
CREATE TRIGGER `entries_event_upd` AFTER UPDATE OF `state` ON `transfer_entries` WHEN NEW.`state` IS NOT OLD.`state` BEGIN INSERT INTO `transfer_events` (`op_id`, `entry_id`, `state`, `payload`) VALUES (NEW.`op_id`, NEW.`id`, NEW.`state`, json_object('kind', NEW.`kind`, 'state', NEW.`state`, 'rowId', NEW.`target_row_id`, 'sourceId', NEW.`source_row_id`, 'origin', NEW.`origin_id`)); END;--> statement-breakpoint
CREATE TRIGGER `threads_rewire` BEFORE DELETE ON `threads` BEGIN UPDATE `thread_redirects` SET `successor_thread_id` = (SELECT `successor_thread_id` FROM `thread_redirects` WHERE `source_thread_id` = OLD.`id`) WHERE `successor_thread_id` = OLD.`id`; END;--> statement-breakpoint
CREATE TRIGGER `threads_soft_deleted` AFTER UPDATE OF `deleted_at` ON `threads` WHEN OLD.`deleted_at` IS NULL AND NEW.`deleted_at` IS NOT NULL BEGIN DELETE FROM `queued_thread_messages` WHERE `thread_id` = NEW.`id` AND `forward_source_row_id` IS NOT NULL AND `claim_token` LIKE 'slot:%'; UPDATE `thread_redirects` SET `successor_thread_id` = NULL WHERE `successor_thread_id` = NEW.`id`; DELETE FROM `thread_redirects` WHERE `source_thread_id` = NEW.`id`; END;
