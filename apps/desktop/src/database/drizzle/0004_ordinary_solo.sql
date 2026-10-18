CREATE TABLE `message_parts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`message_id` integer NOT NULL,
	`type` text NOT NULL,
	`content` text NOT NULL,
	`data` text DEFAULT '{}' NOT NULL,
	`tool_call_id` text GENERATED ALWAYS AS (CASE WHEN "type" = 'tool_call' THEN json_extract("data", '$.toolCallId') END) VIRTUAL,
	`tool_kind` text GENERATED ALWAYS AS (CASE WHEN "type" = 'tool_call' THEN json_extract("data", '$.toolKind') END) VIRTUAL,
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

-- Collapse legacy tool_result messages into the tool call that produced them.
--
-- A tool_call part already carries the full execution state in `data`
-- (input/output/status/duration/error), so the separate tool_result message was
-- a duplicate. Result text and attachments move onto the owning call; results
-- that cannot be matched keep their text as assistant content instead of being
-- silently dropped, and the leftover rows are deleted.
--
-- Identity comes from the legacy numeric log reference, and only resolves when
-- the referenced log identifies exactly one tool source. Ambiguous results stay
-- unresolved rather than being guessed from execution order.
CREATE TEMP TABLE `_legacy_tool_result_targets` AS
SELECT
    messages.id AS result_message_id,
    (
        SELECT CASE WHEN COUNT(sources.legacy_id) = 1 THEN MAX(sources.tool_call_id) END
        FROM _legacy_tool_sources AS sources
        WHERE sources.legacy_id = messages.tool_log_id
          AND (sources.tool_kind = messages.tool_log_kind OR messages.tool_log_kind IS NULL)
    ) AS tool_call_id,
    (
        SELECT CASE WHEN COUNT(sources.legacy_id) = 1 THEN MAX(sources.tool_kind) END
        FROM _legacy_tool_sources AS sources
        WHERE sources.legacy_id = messages.tool_log_id
          AND (sources.tool_kind = messages.tool_log_kind OR messages.tool_log_kind IS NULL)
    ) AS tool_kind,
    coalesce(
        (
            SELECT group_concat(content, '') FROM (
                SELECT content FROM message_parts
                WHERE message_id = messages.id AND type = 'text'
                ORDER BY sort_order, id
            )
        ),
        ''
    ) AS result_content
FROM messages
WHERE messages.role = 'tool_result';
--> statement-breakpoint

CREATE TEMP TABLE `_legacy_tool_result_resolved` AS
SELECT
    target.result_message_id,
    target.result_content,
    target.tool_call_id,
    target.tool_kind,
    (
        SELECT call_part.id
        FROM message_parts AS call_part
        INNER JOIN messages AS call_message ON call_message.id = call_part.message_id
        WHERE call_part.type = 'tool_call'
          AND call_part.tool_call_id = target.tool_call_id
          AND call_part.tool_kind = target.tool_kind
          AND call_message.session_id = result_message.session_id
          AND call_message.id <= target.result_message_id
        ORDER BY call_message.id DESC, call_part.sort_order DESC, call_part.id DESC
        LIMIT 1
    ) AS call_part_id
FROM _legacy_tool_result_targets AS target
INNER JOIN messages AS result_message ON result_message.id = target.result_message_id;
--> statement-breakpoint

-- Result text becomes the tool call output when the log update never landed.
UPDATE message_parts
SET data = json_set(data, '$.output', (
        SELECT resolved.result_content
        FROM _legacy_tool_result_resolved AS resolved
        WHERE resolved.call_part_id = message_parts.id
    )),
    updated_at = datetime('now')
WHERE id IN (SELECT call_part_id FROM _legacy_tool_result_resolved WHERE call_part_id IS NOT NULL)
  AND coalesce(json_extract(data, '$.output'), '') = '';
--> statement-breakpoint

-- Attachments belong to the tool call that produced them. Keep the part row
-- (and its attachment_id foreign key) but move it under the tool call message
-- and tag it with the owning call identity.
CREATE TEMP TABLE `_legacy_tool_result_attachments` AS
SELECT
    attachment_part.id AS part_id,
    call_part.message_id AS target_message_id,
    resolved.tool_call_id AS tool_call_id,
    resolved.tool_kind AS tool_kind,
    ROW_NUMBER() OVER (
        PARTITION BY call_part.message_id
        ORDER BY resolved.result_message_id, attachment_part.sort_order, attachment_part.id
    ) AS attachment_index
FROM message_parts AS attachment_part
INNER JOIN _legacy_tool_result_resolved AS resolved
    ON resolved.result_message_id = attachment_part.message_id
   AND resolved.call_part_id IS NOT NULL
INNER JOIN message_parts AS call_part ON call_part.id = resolved.call_part_id
WHERE attachment_part.type = 'attachment';
--> statement-breakpoint

CREATE TEMP TABLE `_legacy_tool_result_attachment_orders` AS
SELECT
    moved.part_id,
    moved.target_message_id,
    moved.tool_call_id,
    moved.tool_kind,
    coalesce(
        (
            SELECT max(existing.sort_order)
            FROM message_parts AS existing
            WHERE existing.message_id = moved.target_message_id
        ),
        -1
    ) + moved.attachment_index AS new_sort_order
FROM _legacy_tool_result_attachments AS moved;
--> statement-breakpoint

UPDATE message_parts
SET message_id = (
        SELECT orders.target_message_id
        FROM _legacy_tool_result_attachment_orders AS orders
        WHERE orders.part_id = message_parts.id
    ),
    sort_order = (
        SELECT orders.new_sort_order
        FROM _legacy_tool_result_attachment_orders AS orders
        WHERE orders.part_id = message_parts.id
    ),
    data = json_set(
        data,
        '$.toolCallId',
        (
            SELECT orders.tool_call_id
            FROM _legacy_tool_result_attachment_orders AS orders
            WHERE orders.part_id = message_parts.id
        ),
        '$.toolKind',
        (
            SELECT orders.tool_kind
            FROM _legacy_tool_result_attachment_orders AS orders
            WHERE orders.part_id = message_parts.id
        )
    ),
    updated_at = datetime('now')
WHERE id IN (SELECT part_id FROM _legacy_tool_result_attachment_orders);
--> statement-breakpoint

DROP TABLE `_legacy_tool_result_attachment_orders`;
--> statement-breakpoint
DROP TABLE `_legacy_tool_result_attachments`;
--> statement-breakpoint

-- Unmatched results have no tool call to attach to. Preserve their text as
-- assistant content instead of silently dropping the only copy of the output.
-- Rows without any renderable part would become empty assistant messages that
-- strict providers reject, so they fall through to the safety-net delete below.
UPDATE messages
SET role = 'assistant',
    updated_at = datetime('now')
WHERE id IN (
    SELECT result_message_id
    FROM _legacy_tool_result_resolved
    WHERE call_part_id IS NULL
      AND (
          trim(result_content) <> ''
          OR EXISTS (
              SELECT 1
              FROM message_parts
              WHERE message_parts.message_id = _legacy_tool_result_resolved.result_message_id
                AND message_parts.type <> 'text'
          )
      )
);
--> statement-breakpoint

-- Matched results are now fully represented by the tool call part.
DELETE FROM messages
WHERE id IN (
    SELECT result_message_id
    FROM _legacy_tool_result_resolved
    WHERE call_part_id IS NOT NULL
);
--> statement-breakpoint

-- Safety net for legacy rows that never carried a result body.
DELETE FROM messages WHERE role = 'tool_result';
--> statement-breakpoint

DROP TABLE `_legacy_tool_result_resolved`;
--> statement-breakpoint
DROP TABLE `_legacy_tool_result_targets`;
--> statement-breakpoint
DROP TABLE temp._legacy_tool_sources;
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
--> statement-breakpoint
CREATE TRIGGER trg_message_parts_search_insert
AFTER INSERT ON message_parts
WHEN NEW.type IN ('text', 'tool_call')
BEGIN
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
    WHERE messages.id IN (NEW.message_id)
      AND EXISTS (SELECT 1 FROM message_parts WHERE message_id = messages.id AND type IN ('text', 'tool_call'));
END;
--> statement-breakpoint

CREATE TRIGGER trg_message_parts_search_delete
AFTER DELETE ON message_parts
WHEN OLD.type IN ('text', 'tool_call')
BEGIN
    DELETE FROM message_search_fts WHERE rowid = OLD.message_id;
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
    WHERE messages.id IN (OLD.message_id)
      AND EXISTS (SELECT 1 FROM message_parts WHERE message_id = messages.id AND type IN ('text', 'tool_call'));
END;
--> statement-breakpoint

CREATE TRIGGER trg_message_parts_search_update
AFTER UPDATE OF message_id, type, content, data, sort_order ON message_parts
WHEN (OLD.type IN ('text', 'tool_call') OR NEW.type IN ('text', 'tool_call'))
 AND (OLD.message_id <> NEW.message_id OR OLD.type <> NEW.type
      OR OLD.content <> NEW.content OR OLD.data <> NEW.data OR OLD.sort_order <> NEW.sort_order)
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
--> statement-breakpoint

DELETE FROM message_search_fts;
--> statement-breakpoint
INSERT INTO message_search_fts(rowid, content)
SELECT message_id, group_concat(content, '')
FROM (
    SELECT
        message_id,
        CASE
            WHEN type = 'text' THEN content
            ELSE coalesce(json_extract(data, '$.output'), '')
        END AS content
    FROM message_parts
    WHERE type IN ('text', 'tool_call')
    ORDER BY message_id, sort_order, id
)
GROUP BY message_id;

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
ALTER TABLE `models` ADD `reasoning_options` text;--> statement-breakpoint
-- Upstream `/v1/models` 声明过的能力，models.dev 同步时用它保持「上游 > 兜底」的优先级。
ALTER TABLE `models` ADD `upstream_metadata` text;
--> statement-breakpoint
CREATE TABLE `llm_metadata_aliases` (
	`alias` text PRIMARY KEY NOT NULL,
	`model_id` text NOT NULL
);
