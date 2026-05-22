CREATE TABLE `attachments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`hash` text NOT NULL,
	`type` text NOT NULL,
	`original_name` text NOT NULL,
	`origin_path` text NOT NULL,
	`mime_type` text,
	`size` integer,
	`created_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `attachments_hash_unique` ON `attachments` (`hash`);--> statement-breakpoint
CREATE TABLE `built_in_tool_logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`tool_id` text NOT NULL,
	`tool_call_id` text NOT NULL,
	`session_id` integer,
	`message_id` integer,
	`iteration` integer DEFAULT 1 NOT NULL,
	`input` text NOT NULL,
	`output` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`approval_state` text DEFAULT 'none' NOT NULL,
	`approval_summary` text,
	`duration_ms` integer,
	`error_message` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `built_in_tools` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`tool_id` text NOT NULL,
	`display_name` text NOT NULL,
	`description` text,
	`enabled` integer DEFAULT 1 NOT NULL,
	`risk_level` text DEFAULT 'medium' NOT NULL,
	`config_json` text,
	`last_used_at` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `built_in_tools_tool_id_unique` ON `built_in_tools` (`tool_id`);--> statement-breakpoint
CREATE TABLE `llm_metadata` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`model_id` text NOT NULL,
	`name` text NOT NULL,
	`attachment` integer DEFAULT 0 NOT NULL,
	`modalities` text NOT NULL,
	`open_weights` integer DEFAULT 0 NOT NULL,
	`reasoning` integer DEFAULT 0 NOT NULL,
	`release_date` text,
	`temperature` integer DEFAULT 1 NOT NULL,
	`tool_call` integer DEFAULT 0 NOT NULL,
	`knowledge` text,
	`limit` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `llm_metadata_model_id_unique` ON `llm_metadata` (`model_id`);--> statement-breakpoint
CREATE TABLE `mcp_servers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`transport_type` text NOT NULL,
	`command` text,
	`args` text,
	`env` text,
	`cwd` text,
	`url` text,
	`headers` text,
	`enabled` integer DEFAULT 1 NOT NULL,
	`tool_timeout` integer DEFAULT 30000 NOT NULL,
	`version` text,
	`last_error` text,
	`last_connected_at` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mcp_servers_name_unique` ON `mcp_servers` (`name`);--> statement-breakpoint
CREATE TABLE `mcp_tool_logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`server_id` integer NOT NULL,
	`tool_name` text NOT NULL,
	`tool_call_id` text NOT NULL,
	`session_id` integer,
	`message_id` integer,
	`iteration` integer DEFAULT 1 NOT NULL,
	`input` text NOT NULL,
	`output` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`duration_ms` integer,
	`error_message` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`server_id`) REFERENCES `mcp_servers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `mcp_tools` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`server_id` integer NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`input_schema` text NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`server_id`) REFERENCES `mcp_servers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `message_attachments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`message_id` integer NOT NULL,
	`attachment_id` integer NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`origin_path` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`attachment_id`) REFERENCES `attachments`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` integer NOT NULL,
	`role` text NOT NULL,
	`content` text NOT NULL,
	`tool_log_id` integer,
	`tool_log_kind` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `models` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`provider_id` integer NOT NULL,
	`name` text NOT NULL,
	`model_id` text NOT NULL,
	`is_default` integer DEFAULT 0 NOT NULL,
	`last_used_at` text,
	`attachment` integer DEFAULT 0 NOT NULL,
	`modalities` text,
	`open_weights` integer DEFAULT 0 NOT NULL,
	`reasoning` integer DEFAULT 0 NOT NULL,
	`release_date` text,
	`temperature` integer DEFAULT 1 NOT NULL,
	`tool_call` integer DEFAULT 0 NOT NULL,
	`knowledge` text,
	`context_limit` integer,
	`output_limit` integer,
	`is_custom_metadata` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`provider_id`) REFERENCES `providers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `providers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`driver` text NOT NULL,
	`api_endpoint` text NOT NULL,
	`api_key` text,
	`config_json` text,
	`logo` text NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`is_builtin` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `attachment_remote_refs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`attachment_id` integer NOT NULL,
	`provider_id` integer NOT NULL,
	`transport_kind` text NOT NULL,
	`remote_ref` text NOT NULL,
	`mime_type` text,
	`expires_at` text,
	`last_used_at` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`attachment_id`) REFERENCES `attachments`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`provider_id`) REFERENCES `providers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `attachment_remote_refs_attachment_provider_transport_unique` ON `attachment_remote_refs` (`attachment_id`,`provider_id`,`transport_kind`);--> statement-breakpoint
CREATE INDEX `attachment_remote_refs_provider_id_idx` ON `attachment_remote_refs` (`provider_id`);--> statement-breakpoint
CREATE TABLE `quick_search_click_stats` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`query_norm` text NOT NULL,
	`path_norm` text NOT NULL,
	`click_count` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `session_turn_attempts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`turn_id` integer NOT NULL,
	`attempt_index` integer NOT NULL,
	`max_retries` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`checkpoint_json` text NOT NULL,
	`delivery_manifest_json` text NOT NULL,
	`error_message` text,
	`duration_ms` integer,
	`started_at` text DEFAULT (datetime('now')) NOT NULL,
	`finished_at` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`turn_id`) REFERENCES `session_turns`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `session_turn_attempts_turn_id_idx` ON `session_turn_attempts` (`turn_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `session_turn_attempts_turn_attempt_unique` ON `session_turn_attempts` (`turn_id`,`attempt_index`);--> statement-breakpoint
CREATE TABLE `session_turns` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` integer,
	`model_id` integer NOT NULL,
	`task_id` text NOT NULL,
	`execution_mode` text DEFAULT 'foreground' NOT NULL,
	`prompt_snapshot_json` text NOT NULL,
	`prompt_message_id` integer,
	`response_message_id` integer,
	`status` text DEFAULT 'pending' NOT NULL,
	`error_message` text,
	`tokens_used` integer,
	`duration_ms` integer,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`model_id`) REFERENCES `models`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`prompt_message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`response_message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `session_turns_session_id_idx` ON `session_turns` (`session_id`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` text NOT NULL,
	`title` text NOT NULL,
	`model` text NOT NULL,
	`provider_id` integer,
	`last_message_preview` text,
	`last_message_at` text,
	`message_count` integer DEFAULT 0 NOT NULL,
	`status_badge_dismissed_turn_id` integer,
	`pinned_at` text,
	`archived_at` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`provider_id`) REFERENCES `providers`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_session_id_unique` ON `sessions` (`session_id`);--> statement-breakpoint
CREATE INDEX `sessions_provider_id_idx` ON `sessions` (`provider_id`);--> statement-breakpoint
CREATE INDEX `sessions_archived_at_idx` ON `sessions` (`archived_at`);--> statement-breakpoint
CREATE INDEX `sessions_pinned_at_idx` ON `sessions` (`pinned_at`);--> statement-breakpoint
CREATE INDEX `sessions_last_message_at_idx` ON `sessions` (`last_message_at`);--> statement-breakpoint
CREATE TABLE `settings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`key` text NOT NULL,
	`value` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `settings_key_unique` ON `settings` (`key`);--> statement-breakpoint
CREATE TABLE `statistics` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`key` text NOT NULL,
	`value` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `statistics_key_unique` ON `statistics` (`key`);--> statement-breakpoint
CREATE TABLE `touchai_meta` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`key` text NOT NULL,
	`value` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `touchai_meta_key_unique` ON `touchai_meta` (`key`);
