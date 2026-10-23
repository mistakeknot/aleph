CREATE TABLE IF NOT EXISTS `event_cold_segments` (
	`segment_id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`lifecycle` text NOT NULL,
	`path` text NOT NULL,
	`first_sequence` integer NOT NULL,
	`last_sequence` integer NOT NULL,
	`row_count` integer NOT NULL,
	`event_ids_sha256` text NOT NULL,
	`body_sha256` text NOT NULL,
	`file_sha256` text NOT NULL,
	`file_bytes` integer NOT NULL,
	`header_bytes` integer NOT NULL,
	`decompressed_bytes` integer NOT NULL,
	`format_version` integer NOT NULL,
	`transform_versions` text NOT NULL,
	`created_at` integer NOT NULL,
	`ended_at` integer
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `event_cold_segments_thread_idx` ON `event_cold_segments` (`thread_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `event_cold_segments_lifecycle_idx` ON `event_cold_segments` (`lifecycle`);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `event_cold_segments_path_idx` ON `event_cold_segments` (`path`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `thread_event_cold_state` (
	`thread_id` text PRIMARY KEY NOT NULL,
	`state` text NOT NULL,
	`live_segment_id` text,
	`last_rehydrated_at` integer,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "thread_event_cold_state_shape_check" CHECK((
        ("thread_event_cold_state"."state" = 'cold' AND "thread_event_cold_state"."live_segment_id" IS NOT NULL)
        OR
        ("thread_event_cold_state"."state" = 'hot' AND "thread_event_cold_state"."live_segment_id" IS NULL)
      ))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `thread_event_cold_state_state_idx` ON `thread_event_cold_state` (`state`);