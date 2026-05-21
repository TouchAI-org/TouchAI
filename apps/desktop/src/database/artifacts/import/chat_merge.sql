INSERT INTO main.sessions (
    session_id, title, model, provider_id, last_message_preview, last_message_at,
    message_count, pinned_at, archived_at, created_at, updated_at
)
SELECT
    source_sessions.session_id,
    source_sessions.title,
    source_sessions.model,
    target_session_providers.id,
    source_sessions.last_message_preview,
    source_sessions.last_message_at,
    source_sessions.message_count,
    source_sessions.pinned_at,
    source_sessions.archived_at,
    source_sessions.created_at,
    source_sessions.updated_at
FROM imported.sessions AS source_sessions
LEFT JOIN imported.providers AS source_session_providers
    ON source_session_providers.id = source_sessions.provider_id
LEFT JOIN main.providers AS target_session_providers
    ON target_session_providers.name = source_session_providers.name
   AND target_session_providers.driver = source_session_providers.driver
WHERE true
ON CONFLICT(session_id) DO UPDATE SET
    title = excluded.title,
    model = excluded.model,
    provider_id = excluded.provider_id,
    last_message_preview = excluded.last_message_preview,
    last_message_at = excluded.last_message_at,
    message_count = excluded.message_count,
    pinned_at = excluded.pinned_at,
    archived_at = excluded.archived_at,
    updated_at = excluded.updated_at;

DROP TABLE IF EXISTS temp_session_map;
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

DROP TABLE IF EXISTS temp_ranked_source_messages;
CREATE TEMP TABLE temp_ranked_source_messages AS
WITH source_messages_with_target_session AS (
    SELECT
        source_messages.id AS source_message_id,
        session_map.target_session_id,
        source_messages.role,
        source_messages.content,
        source_messages.created_at,
        source_messages.updated_at
    FROM imported.messages AS source_messages
    INNER JOIN temp_session_map AS session_map
        ON session_map.source_session_id = source_messages.session_id
)
SELECT
    source_message_id,
    target_session_id,
    role,
    content,
    created_at,
    updated_at,
    ROW_NUMBER() OVER (
        PARTITION BY target_session_id, role, content, created_at
        ORDER BY source_message_id
    ) AS occurrence_index
FROM source_messages_with_target_session;

DROP TABLE IF EXISTS temp_ranked_target_messages;
CREATE TEMP TABLE temp_ranked_target_messages AS
WITH target_messages_in_scope AS (
    SELECT
        target_messages.id AS target_message_id,
        target_messages.session_id AS target_session_id,
        target_messages.role,
        target_messages.content,
        target_messages.created_at
    FROM main.messages AS target_messages
    WHERE target_messages.session_id IN (
        SELECT target_session_id
        FROM temp_session_map
    )
)
SELECT
    target_message_id,
    target_session_id,
    role,
    content,
    created_at,
    ROW_NUMBER() OVER (
        PARTITION BY target_session_id, role, content, created_at
        ORDER BY target_message_id
    ) AS occurrence_index
FROM target_messages_in_scope;

INSERT INTO main.messages (
    session_id, role, content, created_at, updated_at
)
SELECT
    source_messages.target_session_id,
    source_messages.role,
    source_messages.content,
    source_messages.created_at,
    source_messages.updated_at
FROM temp_ranked_source_messages AS source_messages
LEFT JOIN temp_ranked_target_messages AS target_messages
    ON target_messages.target_session_id = source_messages.target_session_id
   AND target_messages.role = source_messages.role
   AND target_messages.content = source_messages.content
   AND target_messages.created_at = source_messages.created_at
   AND target_messages.occurrence_index = source_messages.occurrence_index
WHERE target_messages.target_message_id IS NULL;

DROP TABLE IF EXISTS temp_ranked_target_messages;
CREATE TEMP TABLE temp_ranked_target_messages AS
WITH target_messages_in_scope AS (
    SELECT
        target_messages.id AS target_message_id,
        target_messages.session_id AS target_session_id,
        target_messages.role,
        target_messages.content,
        target_messages.created_at
    FROM main.messages AS target_messages
    WHERE target_messages.session_id IN (
        SELECT target_session_id
        FROM temp_session_map
    )
)
SELECT
    target_message_id,
    target_session_id,
    role,
    content,
    created_at,
    ROW_NUMBER() OVER (
        PARTITION BY target_session_id, role, content, created_at
        ORDER BY target_message_id
    ) AS occurrence_index
FROM target_messages_in_scope;

DROP TABLE IF EXISTS temp_message_map;
CREATE TEMP TABLE temp_message_map (
    source_message_id INTEGER PRIMARY KEY,
    target_message_id INTEGER NOT NULL
);

INSERT INTO temp_message_map (source_message_id, target_message_id)
SELECT
    source_messages.source_message_id,
    target_messages.target_message_id
FROM temp_ranked_source_messages AS source_messages
INNER JOIN temp_ranked_target_messages AS target_messages
    ON target_messages.target_session_id = source_messages.target_session_id
   AND target_messages.role = source_messages.role
   AND target_messages.content = source_messages.content
   AND target_messages.created_at = source_messages.created_at
   AND target_messages.occurrence_index = source_messages.occurrence_index;

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

INSERT INTO main.message_attachments (
    message_id, attachment_id, sort_order, origin_path, created_at
)
SELECT
    message_map.target_message_id,
    target_attachments.id,
    source_message_attachments.sort_order,
    source_message_attachments.origin_path,
    source_message_attachments.created_at
FROM imported.message_attachments AS source_message_attachments
INNER JOIN temp_message_map AS message_map
    ON message_map.source_message_id = source_message_attachments.message_id
INNER JOIN imported.attachments AS source_attachments
    ON source_attachments.id = source_message_attachments.attachment_id
INNER JOIN main.attachments AS target_attachments
    ON target_attachments.hash = source_attachments.hash
WHERE NOT EXISTS (
    SELECT 1
    FROM main.message_attachments AS existing_message_attachments
    WHERE existing_message_attachments.message_id = message_map.target_message_id
      AND existing_message_attachments.attachment_id = target_attachments.id
      AND existing_message_attachments.sort_order = source_message_attachments.sort_order
);

DROP TABLE IF EXISTS temp_resolved_turns;
CREATE TEMP TABLE temp_resolved_turns AS
SELECT
    source_turns.id AS source_turn_id,
    session_map.target_session_id,
    target_models.id AS target_model_id,
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
INNER JOIN temp_session_map AS session_map
    ON session_map.source_session_id = source_turns.session_id
INNER JOIN imported.models AS source_models
    ON source_models.id = source_turns.model_id
INNER JOIN imported.providers AS source_providers
    ON source_providers.id = source_models.provider_id
INNER JOIN main.providers AS target_providers
    ON target_providers.name = source_providers.name
   AND target_providers.driver = source_providers.driver
INNER JOIN main.models AS target_models
    ON target_models.provider_id = target_providers.id
   AND target_models.model_id = source_models.model_id
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
    WHERE existing_turns.session_id = resolved_turns.target_session_id
      AND existing_turns.model_id = resolved_turns.target_model_id
      AND existing_turns.task_id = resolved_turns.task_id
      AND existing_turns.prompt_message_id IS resolved_turns.target_prompt_message_id
      AND existing_turns.created_at = resolved_turns.created_at
);

DROP TABLE IF EXISTS temp_turn_map;
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
    ON target_turns.session_id = resolved_turns.target_session_id
   AND target_turns.model_id = resolved_turns.target_model_id
   AND target_turns.task_id = resolved_turns.task_id
   AND target_turns.prompt_message_id IS resolved_turns.target_prompt_message_id
   AND target_turns.created_at = resolved_turns.created_at
GROUP BY resolved_turns.source_turn_id;

UPDATE main.session_turns
SET
    response_message_id = (
        SELECT resolved_turns.target_response_message_id
        FROM temp_turn_map AS turn_map
        INNER JOIN temp_resolved_turns AS resolved_turns
            ON resolved_turns.source_turn_id = turn_map.source_turn_id
        WHERE turn_map.target_turn_id = main.session_turns.id
    ),
    status = (
        SELECT resolved_turns.status
        FROM temp_turn_map AS turn_map
        INNER JOIN temp_resolved_turns AS resolved_turns
            ON resolved_turns.source_turn_id = turn_map.source_turn_id
        WHERE turn_map.target_turn_id = main.session_turns.id
    ),
    error_message = (
        SELECT resolved_turns.error_message
        FROM temp_turn_map AS turn_map
        INNER JOIN temp_resolved_turns AS resolved_turns
            ON resolved_turns.source_turn_id = turn_map.source_turn_id
        WHERE turn_map.target_turn_id = main.session_turns.id
    ),
    tokens_used = (
        SELECT resolved_turns.tokens_used
        FROM temp_turn_map AS turn_map
        INNER JOIN temp_resolved_turns AS resolved_turns
            ON resolved_turns.source_turn_id = turn_map.source_turn_id
        WHERE turn_map.target_turn_id = main.session_turns.id
    ),
    duration_ms = (
        SELECT resolved_turns.duration_ms
        FROM temp_turn_map AS turn_map
        INNER JOIN temp_resolved_turns AS resolved_turns
            ON resolved_turns.source_turn_id = turn_map.source_turn_id
        WHERE turn_map.target_turn_id = main.session_turns.id
    ),
    execution_mode = (
        SELECT resolved_turns.execution_mode
        FROM temp_turn_map AS turn_map
        INNER JOIN temp_resolved_turns AS resolved_turns
            ON resolved_turns.source_turn_id = turn_map.source_turn_id
        WHERE turn_map.target_turn_id = main.session_turns.id
    ),
    prompt_snapshot_json = (
        SELECT resolved_turns.prompt_snapshot_json
        FROM temp_turn_map AS turn_map
        INNER JOIN temp_resolved_turns AS resolved_turns
            ON resolved_turns.source_turn_id = turn_map.source_turn_id
        WHERE turn_map.target_turn_id = main.session_turns.id
    ),
    updated_at = (
        SELECT resolved_turns.updated_at
        FROM temp_turn_map AS turn_map
        INNER JOIN temp_resolved_turns AS resolved_turns
            ON resolved_turns.source_turn_id = turn_map.source_turn_id
        WHERE turn_map.target_turn_id = main.session_turns.id
    )
WHERE id IN (SELECT target_turn_id FROM temp_turn_map);

INSERT INTO main.session_turn_attempts (
    turn_id, attempt_index, max_retries, status, checkpoint_json, error_message,
    duration_ms, started_at, finished_at, created_at, updated_at
)
SELECT
    turn_map.target_turn_id,
    source_attempts.attempt_index,
    source_attempts.max_retries,
    source_attempts.status,
    source_attempts.checkpoint_json,
    source_attempts.error_message,
    source_attempts.duration_ms,
    source_attempts.started_at,
    source_attempts.finished_at,
    source_attempts.created_at,
    source_attempts.updated_at
FROM imported.session_turn_attempts AS source_attempts
INNER JOIN temp_turn_map AS turn_map
    ON turn_map.source_turn_id = source_attempts.turn_id
WHERE NOT EXISTS (
    SELECT 1
    FROM main.session_turn_attempts AS existing_attempts
    WHERE existing_attempts.turn_id = turn_map.target_turn_id
      AND existing_attempts.attempt_index = source_attempts.attempt_index
);
