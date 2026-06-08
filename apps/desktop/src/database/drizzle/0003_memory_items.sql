CREATE TABLE `memory_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`title` text NOT NULL,
	`applicability` text NOT NULL,
	`content` text NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`source_session_id` integer,
	`source_message_id` integer,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	`last_used_at` text,
	FOREIGN KEY (`source_session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`source_message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `memory_items_enabled_idx` ON `memory_items` (`enabled`);--> statement-breakpoint
CREATE INDEX `memory_items_updated_at_idx` ON `memory_items` (`updated_at`);
