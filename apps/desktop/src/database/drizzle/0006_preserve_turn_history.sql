PRAGMA foreign_keys=OFF;--> statement-breakpoint
-- Preserve the AUTOINCREMENT watermark even when higher historical row IDs were deleted.
CREATE TEMP TABLE temp_turn_history_sequence AS
SELECT coalesce(max(seq), 0) AS seq FROM sqlite_sequence WHERE name = 'session_turns';
--> statement-breakpoint
CREATE TABLE `__new_session_turns` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` integer,
	`model_id` integer,
	`model_name` text,
	`provider_name` text,
	`task_id` text NOT NULL,
	`execution_mode` text DEFAULT 'foreground' NOT NULL,
	`prompt_snapshot_json` text NOT NULL,
	`prompt_message_id` integer,
	`response_message_id` integer,
	`status` text DEFAULT 'pending' NOT NULL,
	`error_message` text,
	`tokens_used` integer,
	`duration_ms` integer,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`cache_read_tokens` integer DEFAULT 0 NOT NULL,
	`cache_write_tokens` integer DEFAULT 0 NOT NULL,
	`reasoning_tokens` integer DEFAULT 0 NOT NULL,
	`total_cost_micros` integer DEFAULT 0 NOT NULL,
	`unpriced_calls` integer DEFAULT 0 NOT NULL,
	`ttft_ms` integer,
	`first_text_ms` integer,
	`llm_call_count` integer DEFAULT 0 NOT NULL,
	`tool_call_count` integer DEFAULT 0 NOT NULL,
	`kind` text DEFAULT 'chat' NOT NULL,
	`model_switch_count` integer DEFAULT 0 NOT NULL,
	`tool_argument_error_count` integer DEFAULT 0 NOT NULL,
	`empty_response_count` integer DEFAULT 0 NOT NULL,
	`hit_iteration_ceiling` integer DEFAULT 0 NOT NULL,
	`error_code` text,
	`retry_scope` text,
	`prompt_breakdown_json` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`model_id`) REFERENCES `models`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`prompt_message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`response_message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_session_turns`("id", "session_id", "model_id", "model_name", "provider_name", "task_id", "execution_mode", "prompt_snapshot_json", "prompt_message_id", "response_message_id", "status", "error_message", "tokens_used", "duration_ms", "input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "reasoning_tokens", "total_cost_micros", "unpriced_calls", "ttft_ms", "first_text_ms", "llm_call_count", "tool_call_count", "kind", "model_switch_count", "tool_argument_error_count", "empty_response_count", "hit_iteration_ceiling", "error_code", "retry_scope", "prompt_breakdown_json", "created_at", "updated_at") SELECT "id", "session_id", "model_id", NULL, NULL, "task_id", "execution_mode", "prompt_snapshot_json", "prompt_message_id", "response_message_id", "status", "error_message", "tokens_used", "duration_ms", "input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "reasoning_tokens", "total_cost_micros", "unpriced_calls", "ttft_ms", "first_text_ms", "llm_call_count", "tool_call_count", "kind", "model_switch_count", "tool_argument_error_count", "empty_response_count", "hit_iteration_ceiling", "error_code", "retry_scope", "prompt_breakdown_json", "created_at", "updated_at" FROM `session_turns`;--> statement-breakpoint
DROP TABLE `session_turns`;--> statement-breakpoint
ALTER TABLE `__new_session_turns` RENAME TO `session_turns`;--> statement-breakpoint
-- Older rows have no recorded names; copy only the configuration still available.
UPDATE session_turns
SET model_name = (SELECT name FROM models WHERE id = session_turns.model_id),
    provider_name = (SELECT p.name FROM models AS m JOIN providers AS p ON p.id = m.provider_id
                     WHERE m.id = session_turns.model_id);
--> statement-breakpoint
UPDATE sqlite_sequence
SET seq = max(seq, (SELECT seq FROM temp_turn_history_sequence))
WHERE name = 'session_turns';
--> statement-breakpoint
INSERT INTO sqlite_sequence(name, seq)
SELECT 'session_turns', seq FROM temp_turn_history_sequence
WHERE seq > 0 AND NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'session_turns');
--> statement-breakpoint
DROP TABLE temp_turn_history_sequence;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `session_turns_session_id_idx` ON `session_turns` (`session_id`);--> statement-breakpoint
CREATE INDEX `session_turns_created_at_idx` ON `session_turns` (`created_at`);--> statement-breakpoint
CREATE INDEX `session_turns_model_created_idx` ON `session_turns` (`model_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `session_turns_status_created_idx` ON `session_turns` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `session_turns_session_created_idx` ON `session_turns` (`session_id`,`created_at`,`id`);