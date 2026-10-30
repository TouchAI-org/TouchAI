CREATE TABLE `analytics_outbox` (
	`event_id` text PRIMARY KEY NOT NULL,
	`consent_epoch` integer NOT NULL,
	`schema_version` integer NOT NULL,
	`event_name` text NOT NULL,
	`payload_json` text NOT NULL,
	`payload_bytes` integer NOT NULL,
	`enqueued_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`next_attempt_at` integer NOT NULL,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`priority` integer DEFAULT 100 NOT NULL,
	CONSTRAINT "analytics_outbox_payload_bytes_check" CHECK("analytics_outbox"."payload_bytes" > 0 AND "analytics_outbox"."payload_bytes" <= 2048),
	CONSTRAINT "analytics_outbox_attempt_count_check" CHECK("analytics_outbox"."attempt_count" >= 0)
);
--> statement-breakpoint
CREATE INDEX `analytics_outbox_next_attempt_idx` ON `analytics_outbox` (`next_attempt_at`,`priority`);--> statement-breakpoint
CREATE INDEX `analytics_outbox_expires_at_idx` ON `analytics_outbox` (`expires_at`);--> statement-breakpoint
CREATE TABLE `analytics_state` (
	`id` integer PRIMARY KEY NOT NULL,
	`policy_version` integer DEFAULT 1 NOT NULL,
	`status` text DEFAULT 'uninitialized' NOT NULL,
	`consent_explicit` integer DEFAULT 0 NOT NULL,
	`installation_id` text,
	`consent_epoch` integer DEFAULT 0 NOT NULL,
	`observation_started_day` text,
	`first_success_day` text,
	`last_observed_app_version` text,
	`pending_update_json` text,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	CONSTRAINT "analytics_state_single_row_check" CHECK("analytics_state"."id" = 1),
	CONSTRAINT "analytics_state_status_check" CHECK("analytics_state"."status" IN ('uninitialized', 'enabled', 'disabled')),
	CONSTRAINT "analytics_state_consent_explicit_check" CHECK("analytics_state"."consent_explicit" IN (0, 1)),
	CONSTRAINT "analytics_state_consent_epoch_check" CHECK("analytics_state"."consent_epoch" >= 0)
);
