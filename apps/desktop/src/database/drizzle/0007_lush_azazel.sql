CREATE TABLE `external_agents` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`url` text NOT NULL,
	`protocol` text DEFAULT 'a2a' NOT NULL,
	`agent_card_json` text NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`last_discovered_at` text,
	`last_error` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `external_agents_url_unique` ON `external_agents` (`url`);