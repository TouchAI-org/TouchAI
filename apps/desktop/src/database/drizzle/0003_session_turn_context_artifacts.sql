CREATE TABLE `session_turn_context_artifacts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`turn_id` integer NOT NULL,
	`capsule_id` text NOT NULL,
	`artifact_kind` text NOT NULL,
	`artifact_path` text,
	`mime_type` text,
	`width` integer,
	`height` integer,
	`captured_at` text NOT NULL,
	`metadata_json` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`turn_id`) REFERENCES `session_turns`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `session_turn_context_artifacts_turn_id_idx` ON `session_turn_context_artifacts` (`turn_id`);
--> statement-breakpoint
CREATE INDEX `session_turn_context_artifacts_capsule_id_idx` ON `session_turn_context_artifacts` (`capsule_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_turn_context_artifacts_turn_capsule_kind_unique` ON `session_turn_context_artifacts` (`turn_id`,`capsule_id`,`artifact_kind`);
