CREATE TABLE `thread_search_learned_selections` (
	`query_text` text NOT NULL,
	`thread_id` text NOT NULL,
	`selection_count` integer DEFAULT 1 NOT NULL,
	`last_selected_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`query_text`, `thread_id`),
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `thread_search_learned_selections_query_idx` ON `thread_search_learned_selections` (`query_text`);--> statement-breakpoint
CREATE INDEX `thread_search_learned_selections_thread_idx` ON `thread_search_learned_selections` (`thread_id`);