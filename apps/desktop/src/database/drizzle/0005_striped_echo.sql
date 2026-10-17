CREATE TABLE `usage_daily_rollups` (
	`day` text NOT NULL,
	`model_name` text NOT NULL,
	`provider_name` text NOT NULL,
	`request_count` integer DEFAULT 0 NOT NULL,
	`success_count` integer DEFAULT 0 NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`cache_read_tokens` integer DEFAULT 0 NOT NULL,
	`cache_write_tokens` integer DEFAULT 0 NOT NULL,
	`reasoning_tokens` integer DEFAULT 0 NOT NULL,
	`total_cost_micros` integer DEFAULT 0 NOT NULL,
	`unpriced_count` integer DEFAULT 0 NOT NULL,
	`sum_ttft_ms` integer DEFAULT 0 NOT NULL,
	`sum_duration_ms` integer DEFAULT 0 NOT NULL,
	`ttft_sample_count` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`day`, `model_name`, `provider_name`)
);
--> statement-breakpoint
CREATE INDEX `usage_daily_rollups_day_idx` ON `usage_daily_rollups` (`day`);--> statement-breakpoint
ALTER TABLE `llm_metadata` ADD `input_cost_per_million` text;--> statement-breakpoint
ALTER TABLE `llm_metadata` ADD `output_cost_per_million` text;--> statement-breakpoint
ALTER TABLE `llm_metadata` ADD `cache_read_cost_per_million` text;--> statement-breakpoint
ALTER TABLE `llm_metadata` ADD `cache_write_cost_per_million` text;--> statement-breakpoint
ALTER TABLE `llm_metadata` ADD `cost_currency` text;--> statement-breakpoint
ALTER TABLE `session_turn_attempts` ADD `input_tokens` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `session_turn_attempts` ADD `output_tokens` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `session_turn_attempts` ADD `cache_read_tokens` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `session_turn_attempts` ADD `cache_write_tokens` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `session_turn_attempts` ADD `reasoning_tokens` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `session_turn_attempts` ADD `total_cost_micros` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `session_turn_attempts` ADD `unpriced_calls` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `session_turn_attempts` ADD `ttft_ms` integer;--> statement-breakpoint
ALTER TABLE `session_turn_attempts` ADD `llm_call_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `session_turn_attempts_started_at_idx` ON `session_turn_attempts` (`started_at`);--> statement-breakpoint
ALTER TABLE `session_turns` ADD `input_tokens` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `session_turns` ADD `output_tokens` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `session_turns` ADD `cache_read_tokens` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `session_turns` ADD `cache_write_tokens` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `session_turns` ADD `reasoning_tokens` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `session_turns` ADD `total_cost_micros` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `session_turns` ADD `unpriced_calls` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `session_turns` ADD `ttft_ms` integer;--> statement-breakpoint
ALTER TABLE `session_turns` ADD `first_text_ms` integer;--> statement-breakpoint
ALTER TABLE `session_turns` ADD `llm_call_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `session_turns` ADD `tool_call_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `session_turns` ADD `kind` text DEFAULT 'chat' NOT NULL;--> statement-breakpoint
ALTER TABLE `session_turns` ADD `model_switch_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `session_turns` ADD `tool_argument_error_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `session_turns` ADD `empty_response_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `session_turns` ADD `hit_iteration_ceiling` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `session_turns` ADD `error_code` text;--> statement-breakpoint
ALTER TABLE `session_turns` ADD `retry_scope` text;--> statement-breakpoint
ALTER TABLE `session_turns` ADD `prompt_breakdown_json` text;--> statement-breakpoint
CREATE INDEX `session_turns_created_at_idx` ON `session_turns` (`created_at`);--> statement-breakpoint
CREATE INDEX `session_turns_model_created_idx` ON `session_turns` (`model_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `session_turns_status_created_idx` ON `session_turns` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `message_parts_llm_call_idx` ON `message_parts` (`type`,`started_at`);
--> statement-breakpoint
-- 表达式索引：让 llm_call 片段的 JSON 明细可索引查询（参考 LobeChat 的 usage 表达式索引做法）
CREATE INDEX `message_parts_llm_cost_idx` ON `message_parts` (json_extract(`data`, '$.costMicros')) WHERE `type` = 'llm_call';--> statement-breakpoint
CREATE INDEX `message_parts_llm_ttft_idx` ON `message_parts` (json_extract(`data`, '$.timing.ttftMs')) WHERE `type` = 'llm_call';
