CREATE TABLE `model_preferences` (
    `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
    `name` text NOT NULL,
    `description` text NOT NULL,
    `provider_id` integer,
    `model_id` integer,
    `priority` integer DEFAULT 0 NOT NULL,
    `created_at` text DEFAULT (datetime('now')) NOT NULL,
    `updated_at` text DEFAULT (datetime('now')) NOT NULL,
    FOREIGN KEY (`provider_id`) REFERENCES `providers`(`id`) ON UPDATE no action ON DELETE set null,
    FOREIGN KEY (`model_id`) REFERENCES `models`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `model_preferences_priority_idx` ON `model_preferences` (`priority`);
--> statement-breakpoint
CREATE UNIQUE INDEX `model_preferences_name_unique` ON `model_preferences` (`name`);
--> statement-breakpoint
CREATE INDEX `model_preferences_model_id_idx` ON `model_preferences` (`model_id`);
--> statement-breakpoint
CREATE INDEX `model_preferences_provider_id_idx` ON `model_preferences` (`provider_id`);
