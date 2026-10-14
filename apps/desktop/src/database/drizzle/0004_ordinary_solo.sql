CREATE TABLE `message_parts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`message_id` integer NOT NULL,
	`type` text NOT NULL,
	`content` text NOT NULL,
	`data` text DEFAULT '{}' NOT NULL,
	`tool_call_id` text GENERATED ALWAYS AS (CASE WHEN "type" IN ('tool_call', 'tool_result') THEN json_extract("data", '$.toolCallId') END) VIRTUAL,
	`tool_kind` text GENERATED ALWAYS AS (CASE WHEN "type" IN ('tool_call', 'tool_result') THEN json_extract("data", '$.toolKind') END) VIRTUAL,
	`attachment_id` integer GENERATED ALWAYS AS (CASE WHEN "type" = 'attachment' THEN json_extract("data", '$.attachmentId') END) VIRTUAL,
	`started_at` integer,
	`ended_at` integer,
	`sort_order` integer NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`attachment_id`) REFERENCES `attachments`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "message_parts_data_object_check" CHECK(json_valid("message_parts"."data") AND json_type("message_parts"."data") = 'object'),
	CONSTRAINT "message_parts_attachment_check" CHECK("message_parts"."type" <> 'attachment' OR (json_type("message_parts"."data", '$.attachmentId') IS 'integer' AND json_extract("message_parts"."data", '$.attachmentId') > 0))
);
--> statement-breakpoint
CREATE INDEX `message_parts_tool_call_idx` ON `message_parts` (`tool_kind`,`tool_call_id`);--> statement-breakpoint
CREATE INDEX `message_parts_attachment_idx` ON `message_parts` (`attachment_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `message_parts_message_id_sort_order_idx` ON `message_parts` (`message_id`,`sort_order`);--> statement-breakpoint
-- Preserve existing messages before removing their legacy content columns.
INSERT INTO `message_parts` (`message_id`, `type`, `content`, `sort_order`, `created_at`, `updated_at`)
SELECT `id`, 'reasoning', `reasoning`, 0, `created_at`, `updated_at`
FROM `messages` WHERE coalesce(`reasoning`, '') <> '';
--> statement-breakpoint
INSERT INTO `message_parts` (`message_id`, `type`, `content`, `sort_order`, `created_at`, `updated_at`)
SELECT `id`, 'text', `content`, CASE WHEN coalesce(`reasoning`, '') <> '' THEN 1 ELSE 0 END, `created_at`, `updated_at`
FROM `messages` WHERE `content` <> '';
--> statement-breakpoint
ALTER TABLE `messages` DROP COLUMN `content`;
--> statement-breakpoint
ALTER TABLE `messages` DROP COLUMN `reasoning`;
--> statement-breakpoint
-- Resolve legacy tool logs exactly once. A log that did not have a message is
-- preserved under a synthetic message rather than being silently discarded.
CREATE TEMP TABLE `_legacy_tool_sources` AS
SELECT
    'mcp' AS tool_kind,
    logs.id AS legacy_id,
    COALESCE(
        logs.message_id,
        (
            SELECT MIN(messages.id)
            FROM messages
            WHERE messages.tool_log_id = logs.id
              AND messages.tool_log_kind = 'mcp'
              AND messages.role <> 'tool_result'
        )
    ) AS message_id,
    logs.session_id,
    logs.tool_call_id,
    logs.created_at,
    json_object(
        'server_id', logs.server_id,
        'tool_name', logs.tool_name,
        'iteration', logs.iteration,
        'input', logs.input,
        'output', logs.output,
        'status', logs.status,
        'duration_ms', logs.duration_ms,
        'error_message', logs.error_message
    ) AS data
FROM mcp_tool_logs AS logs
UNION ALL
SELECT
    'builtin' AS tool_kind,
    logs.id AS legacy_id,
    COALESCE(
        logs.message_id,
        (
            SELECT MIN(messages.id)
            FROM messages
            WHERE messages.tool_log_id = logs.id
              AND messages.tool_log_kind = 'builtin'
              AND messages.role <> 'tool_result'
        )
    ) AS message_id,
    logs.session_id,
    logs.tool_call_id,
    logs.created_at,
    json_object(
        'tool_id', logs.tool_id,
        'iteration', logs.iteration,
        'input', logs.input,
        'output', logs.output,
        'status', logs.status,
        'approval_state', logs.approval_state,
        'approval_summary', logs.approval_summary,
        'duration_ms', logs.duration_ms,
        'error_message', logs.error_message,
        'conversation_semantic_json', logs.conversation_semantic_json
    ) AS data
FROM built_in_tool_logs AS logs;
--> statement-breakpoint

-- Result bodies were migrated as text by the previous migration. Preserve their
-- identity before deleting the old message references. Missing kinds are only
-- resolved when the legacy numeric ID identifies exactly one source.
CREATE TEMP TABLE `_legacy_tool_results` AS
SELECT messages.id AS message_id,
       CASE WHEN COUNT(sources.legacy_id) = 1 THEN MAX(sources.tool_call_id) END AS tool_call_id,
       CASE WHEN COUNT(sources.legacy_id) = 1 THEN MAX(sources.tool_kind) END AS tool_kind
FROM messages
LEFT JOIN _legacy_tool_sources AS sources
  ON sources.legacy_id = messages.tool_log_id
 AND (sources.tool_kind = messages.tool_log_kind OR messages.tool_log_kind IS NULL)
WHERE messages.role = 'tool_result'
GROUP BY messages.id;
--> statement-breakpoint
UPDATE message_parts
SET type = 'tool_result',
    data = json_set(data,
        '$.toolCallId', (SELECT tool_call_id FROM _legacy_tool_results WHERE message_id = message_parts.message_id),
        '$.toolKind', (SELECT tool_kind FROM _legacy_tool_results WHERE message_id = message_parts.message_id))
WHERE type = 'text' AND message_id IN (SELECT message_id FROM _legacy_tool_results);
--> statement-breakpoint
INSERT INTO message_parts (message_id, type, content, data, sort_order, created_at, updated_at)
SELECT results.message_id, 'tool_result', '', json_object('toolCallId', results.tool_call_id, 'toolKind', results.tool_kind),
       COALESCE((SELECT MAX(sort_order) + 1 FROM message_parts WHERE message_id = results.message_id), 0),
       messages.created_at, messages.updated_at
FROM _legacy_tool_results AS results
JOIN messages ON messages.id = results.message_id
WHERE NOT EXISTS (SELECT 1 FROM message_parts WHERE message_id = results.message_id AND type = 'tool_result');
--> statement-breakpoint
DROP TABLE _legacy_tool_results;
--> statement-breakpoint

INSERT OR IGNORE INTO sessions (
    session_id, title, model, archived_at, created_at, updated_at
)
SELECT
    '__migration-orphan-tools__',
    'Imported tool activity',
    'migration',
    datetime('now'),
    datetime('now'),
    datetime('now')
WHERE EXISTS (
    SELECT 1 FROM _legacy_tool_sources
    WHERE message_id IS NULL AND session_id IS NULL
);
--> statement-breakpoint

CREATE TEMP TABLE `_legacy_orphan_tool_messages` AS
SELECT
    sources.tool_kind,
    sources.legacy_id,
    COALESCE(
        sources.session_id,
        (SELECT id FROM sessions WHERE session_id = '__migration-orphan-tools__')
    ) AS session_id,
    (SELECT COALESCE(MAX(id), 0) FROM messages)
        + ROW_NUMBER() OVER (ORDER BY sources.tool_kind, sources.legacy_id) AS message_id
FROM _legacy_tool_sources AS sources
WHERE sources.message_id IS NULL;
--> statement-breakpoint

INSERT INTO messages (id, session_id, role, created_at, updated_at)
SELECT
    orphan.message_id,
    orphan.session_id,
    'tool_call',
    sources.created_at,
    sources.created_at
FROM _legacy_orphan_tool_messages AS orphan
INNER JOIN _legacy_tool_sources AS sources
    ON sources.tool_kind = orphan.tool_kind
   AND sources.legacy_id = orphan.legacy_id;
--> statement-breakpoint

CREATE TEMP TABLE `_legacy_tool_sources_resolved` AS
SELECT
    sources.tool_kind,
    sources.legacy_id,
    COALESCE(
        sources.message_id,
        orphan.message_id
    ) AS message_id,
    sources.tool_call_id,
    sources.created_at,
    sources.data
FROM _legacy_tool_sources AS sources
LEFT JOIN _legacy_orphan_tool_messages AS orphan
    ON orphan.tool_kind = sources.tool_kind
   AND orphan.legacy_id = sources.legacy_id;
--> statement-breakpoint

INSERT INTO message_parts (
    message_id, type, content, data,
    sort_order, created_at, updated_at
)
SELECT
    resolved.message_id,
    'tool_call',
    '',
    json_set(resolved.data, '$.toolCallId', resolved.tool_call_id, '$.toolKind', resolved.tool_kind),
    COALESCE(
        (
            SELECT MAX(existing.sort_order) + 1
            FROM message_parts AS existing
            WHERE existing.message_id = resolved.message_id
        ),
        0
    ) + ROW_NUMBER() OVER (
        PARTITION BY resolved.message_id
        ORDER BY resolved.created_at, resolved.tool_kind, resolved.legacy_id
    ) - 1,
    resolved.created_at,
    resolved.created_at
FROM _legacy_tool_sources_resolved AS resolved;
--> statement-breakpoint
DROP TABLE temp._legacy_tool_sources_resolved;
--> statement-breakpoint
DROP TABLE temp._legacy_orphan_tool_messages;
--> statement-breakpoint
DROP TABLE temp._legacy_tool_sources;
--> statement-breakpoint

CREATE TEMP TABLE `_legacy_attachment_sources` AS
SELECT
    source.message_id,
    source.attachment_id,
    source.sort_order AS legacy_sort_order,
    source.origin_path,
    source.created_at
FROM message_attachments AS source;
--> statement-breakpoint

INSERT INTO message_parts (
    message_id, type, content, data,
    sort_order, created_at, updated_at
)
SELECT
    source.message_id,
    'attachment',
    '',
    json_object('attachmentId', source.attachment_id, 'originPath', source.origin_path),
    COALESCE(
        (
            SELECT MAX(existing.sort_order) + 1
            FROM message_parts AS existing
            WHERE existing.message_id = source.message_id
        ),
        0
    ) + ROW_NUMBER() OVER (
        PARTITION BY source.message_id
        ORDER BY source.legacy_sort_order, source.attachment_id
    ) - 1,
    source.created_at,
    source.created_at
FROM _legacy_attachment_sources AS source;
--> statement-breakpoint
DROP TABLE temp._legacy_attachment_sources;
--> statement-breakpoint
DROP TABLE `built_in_tool_logs`;
--> statement-breakpoint
DROP TABLE `mcp_tool_logs`;
--> statement-breakpoint
DROP TABLE `message_attachments`;
--> statement-breakpoint
ALTER TABLE `messages` DROP COLUMN `tool_log_id`;
--> statement-breakpoint
ALTER TABLE `messages` DROP COLUMN `tool_log_kind`;
--> statement-breakpoint
-- Derived search index only: message_parts remains the sole content store.
-- detail=none stores document IDs without token positions. Search verifies candidates
-- against ordered text parts, preserving literal substring and cross-part matches.
CREATE VIRTUAL TABLE `message_search_fts` USING fts5(
    content,
    content='',
    contentless_delete=1,
    tokenize='trigram',
    detail=none
);
--> statement-breakpoint
CREATE TRIGGER trg_messages_search_delete
AFTER DELETE ON messages
BEGIN
    DELETE FROM message_search_fts WHERE rowid = OLD.id;
END;
--> statement-breakpoint
CREATE TRIGGER trg_message_parts_search_insert
AFTER INSERT ON message_parts
WHEN NEW.type IN ('text', 'tool_result')
BEGIN
    INSERT OR REPLACE INTO message_search_fts(rowid, content)
    SELECT messages.id, (
        SELECT group_concat(content, '') FROM (
            SELECT content FROM message_parts
            WHERE message_id = messages.id AND type IN ('text', 'tool_result')
            ORDER BY sort_order, id
        )
    )
    FROM messages
    WHERE messages.id IN (NEW.message_id)
      AND EXISTS (SELECT 1 FROM message_parts WHERE message_id = messages.id AND type IN ('text', 'tool_result'));
END;
--> statement-breakpoint
CREATE TRIGGER trg_message_parts_search_delete
AFTER DELETE ON message_parts
WHEN OLD.type IN ('text', 'tool_result')
BEGIN
    DELETE FROM message_search_fts WHERE rowid = OLD.message_id;
    INSERT OR REPLACE INTO message_search_fts(rowid, content)
    SELECT messages.id, (
        SELECT group_concat(content, '') FROM (
            SELECT content FROM message_parts
            WHERE message_id = messages.id AND type IN ('text', 'tool_result')
            ORDER BY sort_order, id
        )
    )
    FROM messages
    WHERE messages.id IN (OLD.message_id)
      AND EXISTS (SELECT 1 FROM message_parts WHERE message_id = messages.id AND type IN ('text', 'tool_result'));
END;
--> statement-breakpoint
CREATE TRIGGER trg_message_parts_search_update
AFTER UPDATE OF message_id, type, content, sort_order ON message_parts
WHEN (OLD.type IN ('text', 'tool_result') OR NEW.type IN ('text', 'tool_result'))
 AND (OLD.message_id <> NEW.message_id OR OLD.type <> NEW.type
      OR OLD.content <> NEW.content OR OLD.sort_order <> NEW.sort_order)
BEGIN
    DELETE FROM message_search_fts WHERE rowid IN (OLD.message_id, NEW.message_id);
    INSERT OR REPLACE INTO message_search_fts(rowid, content)
    SELECT messages.id, (
        SELECT group_concat(content, '') FROM (
            SELECT content FROM message_parts
            WHERE message_id = messages.id AND type IN ('text', 'tool_result')
            ORDER BY sort_order, id
        )
    )
    FROM messages
    WHERE messages.id IN (OLD.message_id, NEW.message_id)
      AND EXISTS (SELECT 1 FROM message_parts WHERE message_id = messages.id AND type IN ('text', 'tool_result'));
END;
--> statement-breakpoint
INSERT INTO message_search_fts(rowid, content)
SELECT message_id, group_concat(content, '')
FROM (
    SELECT message_id, content FROM message_parts
    WHERE type IN ('text', 'tool_result')
    ORDER BY message_id, sort_order, id
)
GROUP BY message_id;
--> statement-breakpoint
-- Keep execution controls and output boundaries, not another copy of the transcript.
UPDATE session_turn_attempts
SET checkpoint_json = CASE WHEN json_valid(checkpoint_json) AND (
    json_type(checkpoint_json, '$.messages') IS NOT NULL OR json_type(checkpoint_json, '$.activeModel') IS NOT NULL
    OR json_type(checkpoint_json, '$.response') IS NOT NULL OR json_type(checkpoint_json, '$.reasoning') IS NOT NULL
) THEN json_set(
    json_remove(checkpoint_json, '$.messages', '$.activeModel', '$.response', '$.reasoning'),
    '$.activeModelId', json_extract(checkpoint_json, '$.activeModel.id'),
    '$.outputBoundary', json_object(
        'textLength', length(coalesce(json_extract(checkpoint_json, '$.response'), '')),
        'reasoningLength', length(coalesce(json_extract(checkpoint_json, '$.reasoning'), '')),
        'partCount', (length(coalesce(json_extract(checkpoint_json, '$.response'), '')) > 0)
            + (length(coalesce(json_extract(checkpoint_json, '$.reasoning'), '')) > 0)
    )
) ELSE checkpoint_json END;
--> statement-breakpoint
ALTER TABLE `llm_metadata` ADD `reasoning_options` text;--> statement-breakpoint
ALTER TABLE `models` ADD `reasoning_options` text;
