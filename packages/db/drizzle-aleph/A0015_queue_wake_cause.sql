ALTER TABLE `queued_thread_messages` ADD `wake_cause` text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE `queued_thread_messages` ADD `wake_ref` text;