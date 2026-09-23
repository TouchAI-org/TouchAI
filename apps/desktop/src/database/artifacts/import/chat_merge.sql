-- Chat-only imports still need local identity rows for turns and tool parts.
-- Copy metadata only: credentials and executable MCP configuration never cross the
-- chat-only boundary. Full imports replace these placeholders in full_prelude.sql.
INSERT INTO main.providers (
    name, driver, api_endpoint, api_key, config_json, logo,
    enabled, is_builtin, created_at, updated_at
)
SELECT
    source.name, source.driver, source.api_endpoint, NULL, NULL, source.logo,
    0, source.is_builtin, source.created_at, source.updated_at
FROM imported.providers AS source
WHERE NOT EXISTS (
    SELECT 1
    FROM main.providers AS target
    WHERE target.name = source.name
      AND target.driver = source.driver
);

CREATE TEMP TABLE temp_provider_map (
    source_provider_id INTEGER PRIMARY KEY,
    target_provider_id INTEGER NOT NULL
);

INSERT INTO temp_provider_map (source_provider_id, target_provider_id)
SELECT source.id, target.id
FROM imported.providers AS source
INNER JOIN main.providers AS target
    ON target.name = source.name
   AND target.driver = source.driver;

-- Models are non-sensitive metadata, so create missing identities without changing
-- the target's default model selection during a chat-only import.
INSERT INTO main.models (
    provider_id, name, model_id, is_default, last_used_at,
    attachment, modalities, open_weights, reasoning, release_date,
    temperature, tool_call, knowledge, context_limit, output_limit,
    is_custom_metadata, created_at, updated_at
)
SELECT
    provider_map.target_provider_id, source.name, source.model_id, 0, source.last_used_at,
    source.attachment, source.modalities, source.open_weights, source.reasoning,
    source.release_date, source.temperature, source.tool_call, source.knowledge,
    source.context_limit, source.output_limit, source.is_custom_metadata,
    source.created_at, source.updated_at
FROM imported.models AS source
INNER JOIN temp_provider_map AS provider_map
    ON provider_map.source_provider_id = source.provider_id
WHERE NOT EXISTS (
    SELECT 1
    FROM main.models AS target
    WHERE target.provider_id = provider_map.target_provider_id
      AND target.model_id = source.model_id
);

CREATE TEMP TABLE temp_model_map (
    source_model_id INTEGER PRIMARY KEY,
    target_model_id INTEGER NOT NULL
);

INSERT INTO temp_model_map (source_model_id, target_model_id)
SELECT source.id, target.id
FROM imported.models AS source
INNER JOIN temp_provider_map AS provider_map
    ON provider_map.source_provider_id = source.provider_id
INNER JOIN main.models AS target
    ON target.provider_id = provider_map.target_provider_id
   AND target.model_id = source.model_id;

-- Tool parts retain their server identity in data. Create disabled metadata-only
-- placeholders so a missing source server can never resolve to an unrelated local id.
INSERT INTO main.mcp_servers (
    name, transport_type, enabled, tool_timeout, created_at, updated_at
)
SELECT
    source.name, source.transport_type, 0, source.tool_timeout,
    source.created_at, source.updated_at
FROM imported.mcp_servers AS source
WHERE NOT EXISTS (
    SELECT 1
    FROM main.mcp_servers AS target
    WHERE target.name = source.name
);

CREATE TEMP TABLE temp_mcp_server_map (
    source_server_id INTEGER PRIMARY KEY,
    target_server_id INTEGER NOT NULL
);

INSERT INTO temp_mcp_server_map (source_server_id, target_server_id)
SELECT source.id, target.id
FROM imported.mcp_servers AS source
INNER JOIN main.mcp_servers AS target
    ON target.name = source.name;

INSERT INTO main.sessions (
    session_id, title, model, provider_id, last_message_preview, last_message_at,
    message_count, status_badge_dismissed_turn_id, pinned_at, archived_at, created_at, updated_at
)
SELECT
    source_sessions.session_id,
    source_sessions.title,
    source_sessions.model,
    provider_map.target_provider_id,
    source_sessions.last_message_preview,
    source_sessions.last_message_at,
    source_sessions.message_count,
    NULL,
    source_sessions.pinned_at,
    source_sessions.archived_at,
    source_sessions.created_at,
    source_sessions.updated_at
FROM imported.sessions AS source_sessions
LEFT JOIN temp_provider_map AS provider_map
    ON provider_map.source_provider_id = source_sessions.provider_id
WHERE true
ON CONFLICT(session_id) DO UPDATE SET
    title = excluded.title,
    model = excluded.model,
    provider_id = excluded.provider_id,
    last_message_preview = excluded.last_message_preview,
    last_message_at = excluded.last_message_at,
    message_count = excluded.message_count,
    status_badge_dismissed_turn_id = excluded.status_badge_dismissed_turn_id,
    pinned_at = excluded.pinned_at,
    archived_at = excluded.archived_at,
    updated_at = excluded.updated_at;

CREATE TEMP TABLE temp_session_map (
    source_session_id INTEGER PRIMARY KEY,
    target_session_id INTEGER NOT NULL
);

INSERT INTO temp_session_map (source_session_id, target_session_id)
SELECT
    source_sessions.id,
    target_sessions.id
FROM imported.sessions AS source_sessions
INNER JOIN main.sessions AS target_sessions
    ON target_sessions.session_id = source_sessions.session_id;

INSERT INTO main.attachments (
    hash, type, original_name, origin_path, mime_type, size, created_at
)
SELECT
    source_attachments.hash,
    source_attachments.type,
    source_attachments.original_name,
    source_attachments.origin_path,
    source_attachments.mime_type,
    source_attachments.size,
    source_attachments.created_at
FROM imported.attachments AS source_attachments
WHERE NOT EXISTS (
    SELECT 1
    FROM main.attachments AS existing_attachments
    WHERE existing_attachments.hash = source_attachments.hash
);

INSERT INTO main.attachment_remote_refs (
    attachment_id, provider_id, transport_kind, remote_ref, mime_type,
    expires_at, last_used_at, created_at, updated_at
)
SELECT
    target_attachments.id,
    provider_map.target_provider_id,
    source_refs.transport_kind,
    source_refs.remote_ref,
    source_refs.mime_type,
    source_refs.expires_at,
    source_refs.last_used_at,
    source_refs.created_at,
    source_refs.updated_at
FROM imported.attachment_remote_refs AS source_refs
INNER JOIN imported.attachments AS source_attachments
    ON source_attachments.id = source_refs.attachment_id
INNER JOIN main.attachments AS target_attachments
    ON target_attachments.hash = source_attachments.hash
INNER JOIN temp_provider_map AS provider_map
    ON provider_map.source_provider_id = source_refs.provider_id
ON CONFLICT(attachment_id, provider_id, transport_kind) DO UPDATE SET
    remote_ref = excluded.remote_ref,
    mime_type = excluded.mime_type,
    expires_at = excluded.expires_at,
    last_used_at = excluded.last_used_at,
    updated_at = excluded.updated_at;

CREATE TEMP TABLE temp_ranked_source_messages AS
SELECT
    source_messages.id AS source_message_id,
    session_map.target_session_id,
    source_messages.role,
    source_messages.created_at,
    source_messages.updated_at,
    ROW_NUMBER() OVER (
        PARTITION BY session_map.target_session_id, source_messages.role, source_messages.created_at
        ORDER BY source_messages.id
    ) AS occurrence_index
FROM imported.messages AS source_messages
INNER JOIN temp_session_map AS session_map
    ON session_map.source_session_id = source_messages.session_id;

CREATE TEMP TABLE temp_ranked_target_messages AS
SELECT
    target_messages.id AS target_message_id,
    target_messages.session_id AS target_session_id,
    target_messages.role,
    target_messages.created_at,
    ROW_NUMBER() OVER (
        PARTITION BY target_messages.session_id, target_messages.role, target_messages.created_at
        ORDER BY target_messages.id
    ) AS occurrence_index
FROM main.messages AS target_messages
WHERE target_messages.session_id IN (
    SELECT target_session_id
    FROM temp_session_map
);

CREATE TEMP TABLE temp_new_message_map AS
SELECT source_messages.source_message_id,
       (SELECT max(coalesce(max(id), 0), coalesce((SELECT seq FROM main.sqlite_sequence WHERE name = 'messages'), 0)) FROM main.messages) + ROW_NUMBER() OVER (ORDER BY source_messages.source_message_id) AS target_message_id
FROM temp_ranked_source_messages AS source_messages
LEFT JOIN temp_ranked_target_messages AS target_messages
    ON target_messages.target_session_id = source_messages.target_session_id
   AND target_messages.role = source_messages.role
   AND target_messages.created_at = source_messages.created_at
   AND target_messages.occurrence_index = source_messages.occurrence_index
WHERE target_messages.target_message_id IS NULL;

INSERT INTO main.messages (id, session_id, role, created_at, updated_at)
SELECT message_map.target_message_id, source_messages.target_session_id,
       source_messages.role, source_messages.created_at, source_messages.updated_at
FROM temp_ranked_source_messages AS source_messages
INNER JOIN temp_new_message_map AS message_map
    ON message_map.source_message_id = source_messages.source_message_id;

CREATE TEMP TABLE temp_message_map (
    source_message_id INTEGER PRIMARY KEY,
    target_message_id INTEGER NOT NULL
);

-- Match existing messages by stable position, not their current parts. This lets
-- repeated imports complete an interrupted message instead of creating a duplicate.
INSERT INTO temp_message_map (source_message_id, target_message_id)
SELECT
    source_messages.source_message_id,
    target_messages.target_message_id
FROM temp_ranked_source_messages AS source_messages
INNER JOIN temp_ranked_target_messages AS target_messages
    ON target_messages.target_session_id = source_messages.target_session_id
   AND target_messages.role = source_messages.role
   AND target_messages.created_at = source_messages.created_at
   AND target_messages.occurrence_index = source_messages.occurrence_index;

INSERT INTO temp_message_map (source_message_id, target_message_id)
SELECT source_message_id, target_message_id
FROM temp_new_message_map;

-- Synchronize parts by the message-local sort key. Unchanged part rows retain
-- their IDs; removed parts disappear and new parts are inserted.
DELETE FROM main.message_parts AS target_parts
WHERE target_parts.message_id IN (SELECT target_message_id FROM temp_message_map)
  AND NOT EXISTS (
      SELECT 1
      FROM imported.message_parts AS source_parts
      INNER JOIN temp_message_map AS message_map
          ON message_map.source_message_id = source_parts.message_id
      WHERE message_map.target_message_id = target_parts.message_id
        AND source_parts.sort_order = target_parts.sort_order
  );

INSERT INTO main.message_parts (
    message_id, type, content, data,
    started_at, ended_at, sort_order, created_at, updated_at
)
SELECT
    message_map.target_message_id,
    source_parts.type,
    source_parts.content,
    -- Remap references at the write boundary; never copy or mutate the source parts.
    CASE
        WHEN source_parts.type = 'attachment' THEN json_set(source_parts.data, '$.attachmentId', (
            SELECT target_attachments.id
            FROM imported.attachments AS source_attachments
            INNER JOIN main.attachments AS target_attachments
                ON target_attachments.hash = source_attachments.hash
            WHERE source_attachments.id = source_parts.attachment_id
        ))
        WHEN source_parts.type = 'tool_call'
             AND json_extract(source_parts.data, '$.toolKind') = 'mcp'
        THEN json_set(source_parts.data, '$.server_id', (
            SELECT server_map.target_server_id
            FROM temp_mcp_server_map AS server_map
            WHERE server_map.source_server_id = json_extract(source_parts.data, '$.server_id')
        ))
        ELSE source_parts.data
    END,
    source_parts.started_at,
    source_parts.ended_at,
    source_parts.sort_order,
    source_parts.created_at,
    source_parts.updated_at
FROM imported.message_parts AS source_parts
INNER JOIN temp_message_map AS message_map
    ON message_map.source_message_id = source_parts.message_id
ON CONFLICT(message_id, sort_order) DO UPDATE SET
    type = excluded.type,
    content = excluded.content,
    data = excluded.data,
    started_at = excluded.started_at,
    ended_at = excluded.ended_at,
    created_at = excluded.created_at,
    updated_at = excluded.updated_at;

UPDATE main.messages
SET updated_at = (
    SELECT source_messages.updated_at
    FROM imported.messages AS source_messages
    INNER JOIN temp_message_map AS message_map
        ON message_map.source_message_id = source_messages.id
    WHERE message_map.target_message_id = main.messages.id
)
WHERE id IN (SELECT target_message_id FROM temp_message_map);

CREATE TEMP TABLE temp_resolved_turns AS
SELECT
    source_turns.id AS source_turn_id,
    session_map.target_session_id,
    model_map.target_model_id,
    source_turns.task_id,
    source_turns.execution_mode,
    source_turns.prompt_snapshot_json,
    prompt_message_map.target_message_id AS target_prompt_message_id,
    response_message_map.target_message_id AS target_response_message_id,
    source_turns.status,
    source_turns.error_message,
    source_turns.tokens_used,
    source_turns.duration_ms,
    source_turns.created_at,
    source_turns.updated_at
FROM imported.session_turns AS source_turns
LEFT JOIN temp_session_map AS session_map
    ON session_map.source_session_id = source_turns.session_id
INNER JOIN temp_model_map AS model_map
    ON model_map.source_model_id = source_turns.model_id
LEFT JOIN temp_message_map AS prompt_message_map
    ON prompt_message_map.source_message_id = source_turns.prompt_message_id
LEFT JOIN temp_message_map AS response_message_map
    ON response_message_map.source_message_id = source_turns.response_message_id;

INSERT INTO main.session_turns (
    session_id, model_id, task_id, execution_mode, prompt_snapshot_json,
    prompt_message_id, response_message_id, status, error_message,
    tokens_used, duration_ms, created_at, updated_at
)
SELECT
    resolved_turns.target_session_id,
    resolved_turns.target_model_id,
    resolved_turns.task_id,
    resolved_turns.execution_mode,
    resolved_turns.prompt_snapshot_json,
    resolved_turns.target_prompt_message_id,
    resolved_turns.target_response_message_id,
    resolved_turns.status,
    resolved_turns.error_message,
    resolved_turns.tokens_used,
    resolved_turns.duration_ms,
    resolved_turns.created_at,
    resolved_turns.updated_at
FROM temp_resolved_turns AS resolved_turns
WHERE NOT EXISTS (
    SELECT 1
    FROM main.session_turns AS existing_turns
    WHERE existing_turns.session_id IS resolved_turns.target_session_id
      AND existing_turns.model_id = resolved_turns.target_model_id
      AND existing_turns.task_id = resolved_turns.task_id
      AND existing_turns.prompt_message_id IS resolved_turns.target_prompt_message_id
      AND existing_turns.created_at = resolved_turns.created_at
);

CREATE TEMP TABLE temp_turn_map (
    source_turn_id INTEGER PRIMARY KEY,
    target_turn_id INTEGER NOT NULL
);

INSERT INTO temp_turn_map (source_turn_id, target_turn_id)
SELECT
    resolved_turns.source_turn_id,
    MIN(target_turns.id) AS target_turn_id
FROM temp_resolved_turns AS resolved_turns
INNER JOIN main.session_turns AS target_turns
    ON target_turns.session_id IS resolved_turns.target_session_id
   AND target_turns.model_id = resolved_turns.target_model_id
   AND target_turns.task_id = resolved_turns.task_id
   AND target_turns.prompt_message_id IS resolved_turns.target_prompt_message_id
   AND target_turns.created_at = resolved_turns.created_at
GROUP BY resolved_turns.source_turn_id;

UPDATE main.sessions
SET status_badge_dismissed_turn_id = (
    SELECT turn_map.target_turn_id
    FROM imported.sessions AS source_sessions
    INNER JOIN temp_session_map AS session_map
        ON session_map.source_session_id = source_sessions.id
    LEFT JOIN temp_turn_map AS turn_map
        ON turn_map.source_turn_id = source_sessions.status_badge_dismissed_turn_id
    WHERE session_map.target_session_id = main.sessions.id
)
WHERE id IN (SELECT target_session_id FROM temp_session_map);

UPDATE main.session_turns
SET (response_message_id, status, error_message, tokens_used, duration_ms,
     execution_mode, prompt_snapshot_json, updated_at) = (
    SELECT
        resolved_turns.target_response_message_id, resolved_turns.status,
        resolved_turns.error_message, resolved_turns.tokens_used, resolved_turns.duration_ms,
        resolved_turns.execution_mode, resolved_turns.prompt_snapshot_json, resolved_turns.updated_at
    FROM temp_turn_map AS turn_map
    INNER JOIN temp_resolved_turns AS resolved_turns
        ON resolved_turns.source_turn_id = turn_map.source_turn_id
    WHERE turn_map.target_turn_id = main.session_turns.id
)
WHERE id IN (SELECT target_turn_id FROM temp_turn_map);

INSERT INTO main.session_turn_attempts (
    turn_id, attempt_index, max_retries, status, checkpoint_json,
    delivery_manifest_json, error_message, duration_ms, started_at,
    finished_at, created_at, updated_at
)
SELECT
    turn_map.target_turn_id,
    source_attempts.attempt_index,
    source_attempts.max_retries,
    source_attempts.status,
    CASE
        WHEN json_type(source_attempts.checkpoint_json, '$.activeModelId') = 'integer'
        THEN json_set(source_attempts.checkpoint_json, '$.activeModelId', (
            SELECT model_map.target_model_id
            FROM temp_model_map AS model_map
            WHERE model_map.source_model_id = json_extract(
                source_attempts.checkpoint_json, '$.activeModelId'
            )
        ))
        ELSE source_attempts.checkpoint_json
    END,
    source_attempts.delivery_manifest_json,
    source_attempts.error_message,
    source_attempts.duration_ms,
    source_attempts.started_at,
    source_attempts.finished_at,
    source_attempts.created_at,
    source_attempts.updated_at
FROM imported.session_turn_attempts AS source_attempts
INNER JOIN temp_turn_map AS turn_map
    ON turn_map.source_turn_id = source_attempts.turn_id
ON CONFLICT(turn_id, attempt_index) DO UPDATE SET
    max_retries = excluded.max_retries,
    status = excluded.status,
    checkpoint_json = excluded.checkpoint_json,
    delivery_manifest_json = excluded.delivery_manifest_json,
    error_message = excluded.error_message,
    duration_ms = excluded.duration_ms,
    started_at = excluded.started_at,
    finished_at = excluded.finished_at,
    updated_at = excluded.updated_at;

-- Import workspace lives only for this transaction, not the pooled connection.
DROP TABLE temp.temp_turn_map;
DROP TABLE temp.temp_resolved_turns;
DROP TABLE temp.temp_message_map;
DROP TABLE temp.temp_new_message_map;
DROP TABLE temp.temp_ranked_target_messages;
DROP TABLE temp.temp_ranked_source_messages;
DROP TABLE temp.temp_session_map;
DROP TABLE temp.temp_mcp_server_map;
DROP TABLE temp.temp_model_map;
DROP TABLE temp.temp_provider_map;
