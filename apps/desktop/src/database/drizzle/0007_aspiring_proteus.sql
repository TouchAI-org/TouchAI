CREATE TABLE `scheduled_task_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`schedule_id` text NOT NULL,
	`schedule_version` integer NOT NULL,
	`scheduled_for` integer NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	`outcome` text,
	`reason` text,
	`background_task_id` text,
	`session_id` integer,
	`turn_id` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`schedule_id`) REFERENCES `scheduled_tasks`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`turn_id`) REFERENCES `session_turns`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "scheduled_task_runs_outcome_check" CHECK("scheduled_task_runs"."outcome" IS NULL OR "scheduled_task_runs"."outcome" IN ('completed', 'failed', 'cancelled', 'skipped_overlap', 'missed', 'skipped_dst')),
	CONSTRAINT "scheduled_task_runs_schedule_version_check" CHECK("scheduled_task_runs"."schedule_version" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `scheduled_task_runs_occurrence_unique` ON `scheduled_task_runs` (`schedule_id`,`schedule_version`,`scheduled_for`);--> statement-breakpoint
CREATE INDEX `scheduled_task_runs_schedule_time_idx` ON `scheduled_task_runs` (`schedule_id`,`scheduled_for`);--> statement-breakpoint
CREATE INDEX `scheduled_task_runs_active_idx` ON `scheduled_task_runs` (`schedule_id`,`outcome`);--> statement-breakpoint
CREATE TABLE `scheduled_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`prompt` text NOT NULL,
	`model_id` text,
	`provider_id` integer,
	`trigger_type` text NOT NULL,
	`trigger_config` text NOT NULL,
	`timezone` text NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`next_run_at` integer,
	`last_run_at` integer,
	`version` integer DEFAULT 1 NOT NULL,
	`deleted_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "scheduled_tasks_trigger_config_check" CHECK(json_valid("scheduled_tasks"."trigger_config") AND json_type("scheduled_tasks"."trigger_config") = 'object'),
	CONSTRAINT "scheduled_tasks_version_check" CHECK("scheduled_tasks"."version" > 0)
);
--> statement-breakpoint
CREATE INDEX `scheduled_tasks_enabled_next_run_idx` ON `scheduled_tasks` (`deleted_at`,`enabled`,`next_run_at`);