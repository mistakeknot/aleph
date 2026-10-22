CREATE TABLE `idempotent_thread_operations` (
	`id` text PRIMARY KEY NOT NULL,
	`scope` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`status` text DEFAULT 'accepted' NOT NULL,
	`send_at` integer,
	`result_json` text,
	`error_message` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idempotent_thread_operations_scope_key_idx` ON `idempotent_thread_operations` (`scope`,`idempotency_key`);