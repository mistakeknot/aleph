CREATE TABLE `attachment_pending_scan_cursors` (
	`project_id` text PRIMARY KEY NOT NULL,
	`last_name` text,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `connect_binding` (
	`id` integer PRIMARY KEY NOT NULL,
	`runtime` text NOT NULL,
	`issuer` text NOT NULL,
	`server_id` text NOT NULL,
	`owner_user_id` text NOT NULL,
	`bound_at` integer NOT NULL,
	CONSTRAINT "connect_binding_singleton_check" CHECK("connect_binding"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE `gate_assertion_uses` (
	`jti` text PRIMARY KEY NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `gate_assertion_uses_expires_idx` ON `gate_assertion_uses` (`expires_at`);--> statement-breakpoint
CREATE TABLE `relay_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`host_id` text NOT NULL,
	`client_message_id` text NOT NULL,
	`client_message_time` integer NOT NULL,
	`thread_id` text NOT NULL,
	`payload_sha256` text NOT NULL,
	`status` text NOT NULL,
	`attempt` integer DEFAULT 1 NOT NULL,
	`lease_token` text,
	`lease_expires_at` integer,
	`cleanup_token` text,
	`cleanup_expires_at` integer,
	`queued_message_id` text,
	`cancel_reason` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`host_id`) REFERENCES `hosts`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "relay_messages_cleanup_claim_check" CHECK(("relay_messages"."status" = 'cleaning') = ("relay_messages"."cleanup_token" IS NOT NULL AND "relay_messages"."cleanup_expires_at" IS NOT NULL)),
	CONSTRAINT "relay_messages_cleanup_unset_check" CHECK("relay_messages"."status" = 'cleaning' OR ("relay_messages"."cleanup_token" IS NULL AND "relay_messages"."cleanup_expires_at" IS NULL)),
	CONSTRAINT "relay_messages_lease_claim_check" CHECK(("relay_messages"."status" = 'reserved') = ("relay_messages"."lease_token" IS NOT NULL AND "relay_messages"."lease_expires_at" IS NOT NULL)),
	CONSTRAINT "relay_messages_lease_unset_check" CHECK("relay_messages"."status" = 'reserved' OR ("relay_messages"."lease_token" IS NULL AND "relay_messages"."lease_expires_at" IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `relay_messages_host_client_message_idx` ON `relay_messages` (`host_id`,`client_message_id`);--> statement-breakpoint
CREATE INDEX `relay_messages_host_created_idx` ON `relay_messages` (`host_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `relay_messages_status_lease_idx` ON `relay_messages` (`status`,`lease_expires_at`);--> statement-breakpoint
CREATE INDEX `relay_messages_status_cleanup_idx` ON `relay_messages` (`status`,`cleanup_expires_at`);--> statement-breakpoint
CREATE TABLE `relay_targets` (
	`host_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`created_by_user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`host_id`, `thread_id`),
	FOREIGN KEY (`host_id`) REFERENCES `hosts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `relay_usage` (
	`host_id` text NOT NULL,
	`hour_bucket` integer NOT NULL,
	`reservations` integer DEFAULT 0 NOT NULL,
	`attachment_bytes` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`host_id`, `hour_bucket`),
	FOREIGN KEY (`host_id`) REFERENCES `hosts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `project_attachments` ADD `relay_message_id` text;--> statement-breakpoint
ALTER TABLE `project_attachments` ADD `relay_attempt_token` text;--> statement-breakpoint
CREATE INDEX `project_attachments_relay_attempt_idx` ON `project_attachments` (`relay_message_id`,`relay_attempt_token`);--> statement-breakpoint
ALTER TABLE `queued_thread_messages` ADD `relay_provenance` text;