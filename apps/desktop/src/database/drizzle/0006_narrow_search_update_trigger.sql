-- 派生搜索索引只关心正文：text 片段的 content 与 tool_call 片段的 data.output。
-- 工具状态、耗时、审批等 JSON 字段变化不改变被索引文本，不应重建整条消息的 FTS 文档。
-- 删除与插入仍由各自的 trigger 覆盖；这里只收窄 UPDATE 的触发范围。
DROP TRIGGER IF EXISTS `trg_message_parts_search_update`;
--> statement-breakpoint
CREATE TRIGGER `trg_message_parts_search_update`
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
