CREATE TABLE IF NOT EXISTS `aleph_install_requests` (
	`nonce` text PRIMARY KEY NOT NULL,
	`target` text NOT NULL,
	`manifest_digest` text NOT NULL,
	`state` text NOT NULL,
	`requested_at` integer NOT NULL,
	`notified_at` integer,
	`dismissed` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `aleph_install_requests_open_idx` ON `aleph_install_requests` (`state`) WHERE "aleph_install_requests"."state" = 'requested';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `aleph_install_requests_requested_at_idx` ON `aleph_install_requests` (`requested_at`);