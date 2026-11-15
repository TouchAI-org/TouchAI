CREATE TABLE `session_pending_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` integer NOT NULL,
	`position` integer NOT NULL,
	`prompt` text NOT NULL,
	`model_id` text,
	`provider_id` integer,
	`payload_version` integer DEFAULT 1 NOT NULL,
	`payload_json` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`provider_id`) REFERENCES `providers`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "session_pending_messages_payload_json_check" CHECK(json_valid("session_pending_messages"."payload_json") AND json_type("session_pending_messages"."payload_json") = 'object')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_pending_messages_session_position_idx` ON `session_pending_messages` (`session_id`,`position`);