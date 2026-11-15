CREATE TABLE `thread_roles` (
	`role` text PRIMARY KEY NOT NULL,
	`thread_id` text,
	`generation` integer NOT NULL,
	`since` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`updated_by_kind` text NOT NULL,
	`updated_by_thread_id` text,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "thread_roles_role_check" CHECK(typeof("thread_roles"."role") = 'text' AND length("thread_roles"."role") >= 1 AND length("thread_roles"."role") = length(CAST("thread_roles"."role" AS BLOB)) AND "thread_roles"."role" NOT GLOB '*[^a-z0-9-]*'),
	CONSTRAINT "thread_roles_generation_check" CHECK(typeof("thread_roles"."generation") = 'integer' AND "thread_roles"."generation" BETWEEN 1 AND 9007199254740991),
	CONSTRAINT "thread_roles_thread_id_check" CHECK("thread_roles"."thread_id" IS NULL OR typeof("thread_roles"."thread_id") = 'text'),
	CONSTRAINT "thread_roles_times_check" CHECK(typeof("thread_roles"."since") = 'integer' AND typeof("thread_roles"."updated_at") = 'integer'),
	CONSTRAINT "thread_roles_updated_by_kind_check" CHECK("thread_roles"."updated_by_kind" IN ('cli','api','app','system'))
);
--> statement-breakpoint
CREATE INDEX `thread_roles_thread_id_idx` ON `thread_roles` (`thread_id`);
--> statement-breakpoint
CREATE TRIGGER `thread_roles_holder_cleared` AFTER UPDATE OF `thread_id` ON `thread_roles`
WHEN OLD.`thread_id` IS NOT NULL AND NEW.`thread_id` IS NULL AND NEW.`generation` = OLD.`generation`
BEGIN
	UPDATE `thread_roles`
	SET `generation` = OLD.`generation` + 1,
		`since` = CAST(ROUND((julianday('now') - 2440587.5) * 86400000) AS INTEGER),
		`updated_at` = CAST(ROUND((julianday('now') - 2440587.5) * 86400000) AS INTEGER),
		`updated_by_kind` = 'system',
		`updated_by_thread_id` = NULL
	WHERE `role` = NEW.`role`;
END;
