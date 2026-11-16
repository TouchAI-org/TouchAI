-- Only durable content owners require an attachment row in a full backup.
-- Run on the offline snapshot, never on the live database.
WITH snapshot_refs AS MATERIALIZED (
    SELECT reference.key, reference.type, reference.atom
    FROM message_parts AS part, json_tree(part.data) AS reference
    WHERE reference.key IN ('attachmentId', 'hash', 'path', 'sourcePath', 'source_path', 'originPath', 'origin_path')
    UNION ALL
    SELECT reference.key, reference.type, reference.atom
    FROM session_turns AS turn, json_tree(turn.prompt_snapshot_json) AS reference
    WHERE reference.key IN ('hash', 'path', 'sourcePath', 'source_path', 'originPath', 'origin_path')
)
DELETE FROM attachments AS attachment
WHERE NOT EXISTS (
    SELECT 1 FROM message_parts AS part WHERE part.attachment_id = attachment.id
)
AND NOT EXISTS (
    SELECT 1 FROM snapshot_refs AS reference
    WHERE (reference.key = 'attachmentId' AND reference.type = 'integer' AND reference.atom = attachment.id)
       OR (reference.key = 'hash' AND reference.type = 'text' AND reference.atom = attachment.hash)
       OR (reference.type = 'text' AND reference.key IN ('path', 'sourcePath', 'source_path', 'originPath', 'origin_path')
           AND replace(reference.atom, char(92), '/') LIKE '%/' || substr(attachment.hash, 1, 3) || '/' || attachment.hash)
);
