ALTER TABLE `message_parts` ADD COLUMN `tool_id` text GENERATED ALWAYS AS (CASE WHEN "type" = 'tool_call' THEN json_extract("data", '$."tool_id"') END) VIRTUAL;--> statement-breakpoint
ALTER TABLE `message_parts` ADD COLUMN `server_id` integer GENERATED ALWAYS AS (CASE WHEN "type" = 'tool_call' THEN json_extract("data", '$."server_id"') END) VIRTUAL;--> statement-breakpoint
CREATE INDEX `message_parts_tool_id_idx` ON `message_parts` (`tool_kind`,`tool_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `message_parts_server_id_idx` ON `message_parts` (`tool_kind`,`server_id`,`created_at`,`id`);
