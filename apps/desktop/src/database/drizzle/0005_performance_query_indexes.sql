ALTER TABLE `message_parts` ADD `tool_id` text GENERATED ALWAYS AS (CASE WHEN "type" = 'tool_call' THEN json_extract("data", '$."tool_id"') END) VIRTUAL;--> statement-breakpoint
ALTER TABLE `message_parts` ADD `server_id` integer GENERATED ALWAYS AS (CASE WHEN "type" = 'tool_call' THEN json_extract("data", '$."server_id"') END) VIRTUAL;--> statement-breakpoint
CREATE INDEX `message_parts_tool_id_idx` ON `message_parts` (`tool_kind`,`tool_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `message_parts_server_id_idx` ON `message_parts` (`tool_kind`,`server_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `messages_session_id_id_idx` ON `messages` (`session_id`,`id`);--> statement-breakpoint
CREATE INDEX `session_turns_session_created_idx` ON `session_turns` (`session_id`,`created_at`,`id`);--> statement-breakpoint
-- Keep this expression as SQL; the generator splits its commas into quoted column names.
CREATE INDEX `sessions_activity_idx` ON `sessions` (coalesce("last_message_at", "updated_at") DESC, "id" DESC);
--> statement-breakpoint
-- Status-only tool updates do not change searchable content.
DROP TRIGGER trg_message_parts_search_update;
--> statement-breakpoint
CREATE TRIGGER trg_message_parts_search_update
AFTER UPDATE OF message_id, type, content, data, sort_order ON message_parts
WHEN (OLD.type IN ('text', 'tool_call') OR NEW.type IN ('text', 'tool_call'))
 AND (
     OLD.message_id IS NOT NEW.message_id
     OR OLD.type IS NOT NEW.type
     OR OLD.sort_order IS NOT NEW.sort_order
     OR (OLD.type = 'text' AND NEW.type = 'text' AND OLD.content IS NOT NEW.content)
     OR (
         OLD.type = 'tool_call' AND NEW.type = 'tool_call'
         AND coalesce(json_extract(OLD.data, '$.output'), '')
             IS NOT coalesce(json_extract(NEW.data, '$.output'), '')
     )
 )
BEGIN
    DELETE FROM message_search_fts WHERE rowid IN (OLD.message_id, NEW.message_id);
    INSERT OR REPLACE INTO message_search_fts(rowid, content)
    SELECT messages.id, (
        SELECT group_concat(content, '') FROM (
            SELECT CASE
                       WHEN type = 'text' THEN content
                       ELSE coalesce(json_extract(data, '$.output'), '')
                   END AS content
            FROM message_parts
            WHERE message_id = messages.id AND type IN ('text', 'tool_call')
            ORDER BY sort_order, id
        )
    )
    FROM messages
    WHERE messages.id IN (OLD.message_id, NEW.message_id)
      AND EXISTS (SELECT 1 FROM message_parts WHERE message_id = messages.id AND type IN ('text', 'tool_call'));
END;
