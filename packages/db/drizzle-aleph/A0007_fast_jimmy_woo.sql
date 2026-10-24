ALTER TABLE `app_theme` ADD `music_mode` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `app_theme` ADD `music_port` integer DEFAULT 47615 NOT NULL;--> statement-breakpoint
ALTER TABLE `app_theme` ADD `music_secret` text;